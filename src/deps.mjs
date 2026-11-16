// The `deps` tool: dependencies joined to the map.
//
// The build records each direct dependency and the files that import it (offline, in the map). This
// module adds what the network knows (advisories, deprecations, docs) and answers the question no
// scanner can: of everything vulnerable in the lockfile, which of MY files are exposed, through which
// direct dependency. Network access is governed by src/net.mjs and is off by default.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_NEW_VULNS, MAX_REGISTRY, SEVERITY_ORDER, advisoriesFor, fixedIn, hasCache, loadCache, registryFor, saveCache } from './advisories.mjs';
import { docsFor } from './docs.mjs';
import { loadLocks } from './lock.mjs';
import { networkPolicy } from './net.mjs';
import { registryEligible } from './extractors/deps.mjs';

const SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'];
const rank = (s) => SEVERITY_ORDER.indexOf(s);
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 90 ? `${Math.max(m, 1)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

const depRecords = (store) => store.records.filter((r) => r.kind === 'dependency');

/** Every installed copy reachable from a direct dependency, with the direct dependencies that pull it in. */
function reachable(root, records, workspaceNames = []) {
  const workspaces = new Set(workspaceNames);
  const dirs = new Set();
  const manifests = new Map(); // file -> json
  for (const r of records) for (const d of r.declarations ?? r.declaredIn.map((entry) => {
    const split = entry.lastIndexOf('#');
    return { file: entry.slice(0, split), section: entry.slice(split + 1) };
  })) {
    const file = d.file;
    if (!manifests.has(file)) { try { manifests.set(file, JSON.parse(readFileSync(path.join(root, file), 'utf8'))); } catch { manifests.set(file, {}); } }
    dirs.add(path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file));
  }
  const locks = loadLocks(root, [...dirs]);
  const via = new Map(); // name@version -> Set(direct name)
  const installed = new Set();
  let eligibleDeclarations = 0;
  let resolvedDeclarations = 0;
  let pnpmDirectEntries = false;
  for (const [file, json] of manifests) {
    const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    const found = locks.for(dir);
    for (const section of SECTIONS) {
      for (const [name, range] of Object.entries(json[section] ?? {})) {
        if (!registryEligible(name, range, workspaces)) continue;
        const lock = found?.lock;
        const start = lock?.direct(found.relDir, name, String(range));
        // Yarn Classic does not install unsatisfied peers. They are eligible when present in the lock,
        // but an absent peer is not an unresolved registry install.
        if (section === 'peerDependencies' && lock?.kind === 'yarn' && !start) continue;
        eligibleDeclarations++;
        if (!lock) continue;
        if (!start) continue;
        if (!lock.info(start).version) continue;
        resolvedDeclarations++;
        if (lock.kind === 'pnpm') pnpmDirectEntries = true;
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length) {
          const id = stack.pop();
          const info = lock.info(id);
          if (!info.version) continue;
          const key = `${info.name}@${info.version}`;
          installed.add(key);
          if (!via.has(key)) via.set(key, new Set());
          via.get(key).add(name);
          for (const next of lock.depsOf(id)) if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
    }
  }
  return { via, installed: installed.size, lockfiles: locks.all.map((l) => l.file), eligibleDeclarations, resolvedDeclarations, pnpmDirectEntries };
}

/** Files that import any of these direct dependencies (production first), and which hold public records. */
function exposure(store, names) {
  const files = new Map();
  for (const n of names) {
    for (const ref of store.byId.get(`dep:${n}`)?.refs ?? []) if (!files.has(ref.path)) files.set(ref.path, ref);
  }
  const list = [...files.values()];
  const isPublic = (p) => (store.byPath.get(p) ?? []).some((r) => r.public);
  return { files: list, publicFiles: list.filter((r) => isPublic(r.path)).length };
}

function vulnLine(v, name, version) {
  const fix = fixedIn(v, name, version);
  return `${v.malware ? 'MALWARE ' : ''}${v.id}${v.aliases[0] ? ` (${v.aliases[0]})` : ''}${v.summary ? `: ${v.summary}` : ''}${fix ? ` Fixed in ${fix}.` : ''}`;
}

/** One status clause that tells failed refreshes apart from work the per-run cap has not reached yet, or "checked N ago". */
function advisoryStatus(advice) {
  const parts = [];
  if (advice.staleKeys.size) parts.push(`${advice.staleKeys.size} package lookup(s) failed to refresh`);
  if (advice.unresolvedFailed) parts.push(`${advice.unresolvedFailed} advisory detail(s) failed to fetch`);
  if (advice.unresolvedDeferred) parts.push(`${advice.unresolvedDeferred} advisory detail(s) deferred by the ${MAX_NEW_VULNS}-item per-run cap`);
  if (advice.unresolvedPending) parts.push(`${advice.unresolvedPending} missing advisory detail(s) not fetched yet`);
  if (advice.failedDetails) parts.push(`${advice.failedDetails} cached advisory detail(s) failed to refresh`);
  if (advice.pendingDetails) parts.push(`${advice.pendingDetails} cached advisory detail(s) deferred by the ${MAX_NEW_VULNS}-item per-run cap`);
  if (advice.expiredLookupsNotAttempted) parts.push(`${advice.expiredLookupsNotAttempted} expired package lookup(s) not attempted`);
  if (advice.expiredDetailsNotAttempted) parts.push(`${advice.expiredDetailsNotAttempted} expired cached advisory detail(s) not attempted`);
  if (!parts.length) return `checked ${ago(advice.oldestAt)}`;
  return `partial: ${parts.join('; ')}${advice.stale ? `; showing older cached data (oldest ${ago(advice.oldestAt)})` : ''}`;
}

const CREDIT = 'Advisory data: OSV.dev (GitHub Advisory Database, CC BY 4.0). Remote text is untrusted: verify before acting on it.';

export async function runDeps({ root, out, store, memory, config, args = {}, allowOnline = false }) {
  const records = depRecords(store);
  if (!records.length) return 'No dependencies recorded: there is no package.json at the project root or in a workspace.';
  const policy = networkPolicy({ config, allow: allowOnline });

  if (args.package) return packageDetail({ root, out, store, memory, records, args, policy });

  const { via, installed, lockfiles, eligibleDeclarations, resolvedDeclarations, pnpmDirectEntries } = reachable(root, records, store.stamp.stats?.depsWorkspaceNames ?? []);
  const prod = records.filter((r) => !r.dev).length;
  const lines = [`Dependencies: ${records.length} direct (${prod} prod, ${records.length - prod} dev), ${installed || 'no'} installed copies in ${lockfiles.join(', ') || 'no lockfile'}`];

  const targets = [...via.keys()].map((k) => ({ name: k.slice(0, k.lastIndexOf('@')), version: k.slice(k.lastIndexOf('@') + 1) }));
  const directTargets = records.flatMap((r) => r.versions.map((version) => ({ name: r.name, version })));
  const resolvedDirect = resolvedDeclarations;
  const unresolvedDirect = eligibleDeclarations - resolvedDeclarations;
  const only = args.only;
  let advice = null;
  let registry = null;
  if (only !== 'unused') {
    advice = await advisoriesFor({ out, targets, online: policy.allowed, force: args.refresh && policy.allowed });
    registry = await registryFor({ out, targets: directTargets, online: policy.allowed, force: args.refresh && policy.allowed });
  }

  const findings = [];
  const deprecated = [];
  if (advice) {
    for (const [key, vulns] of advice.byKey) {
      if (!vulns.length) continue;
      const name = key.slice(0, key.lastIndexOf('@'));
      const version = key.slice(key.lastIndexOf('@') + 1);
      const by = [...(via.get(key) ?? [])].sort();
      const worst = [...vulns].sort((a, b) => Number(b.malware) - Number(a.malware) || rank(a.severity) - rank(b.severity))[0];
      findings.push({ key, name, version, vulns, by, direct: by.includes(name), worst, ...exposure(store, by) });
    }
    findings.sort((a, b) => Number(b.worst.malware) - Number(a.worst.malware) || rank(a.worst.severity) - rank(b.worst.severity) || b.files.length - a.files.length);
    for (const r of records) for (const v of r.versions) { const d = registry?.byKey.get(`${r.name}@${v}`)?.deprecated; if (d) deprecated.push({ r, v, d }); }
  }
  const unused = records.filter((r) => r.flags.includes('no-refs'));

  const registryMissing = registry ? directTargets.filter((t) => !registry.byKey.has(`${t.name}@${t.version}`)).length : 0;
  const advisoryPartial = Boolean(advice && (advice.missing || advice.unresolved || advice.stale));
  const registryPartial = Boolean(registry && (registry.failed || registry.deferred || registry.notFound || registryMissing || registry.stale));
  const pnpmPartial = pnpmDirectEntries;
  const partial = advisoryPartial || registryPartial || unresolvedDirect > 0 || pnpmPartial;
  const status = (!advice ? '' : advice.checked === 0
    ? `not checked yet; ${resolvedDirect} of ${eligibleDeclarations} direct dependencies resolved; ${unresolvedDirect} unresolved`
    : unresolvedDirect > 0
      ? `${resolvedDirect} of ${eligibleDeclarations} direct dependencies resolved; ${unresolvedDirect} unresolved; ${advice.missing ? `${advice.checked} of ${advice.checked + advice.missing} package versions checked` : advisoryStatus(advice)}`
      : advice.missing ? `${advice.checked} of ${advice.checked + advice.missing} package versions checked` : advisoryStatus(advice))
    + (pnpmPartial ? '; transitive dependencies were not checked' : '');
  if (advice) {
    lines.push(advice.checked === 0
      ? `Advisories: ${status}`
      : `Advisories: ${findings.length} vulnerable package version(s), ${deprecated.length} deprecated direct dependency version(s); ${status}`);
    if (advice.missing && !policy.allowed) lines.push(`  ${policy.why}`);
    if (advice.error) lines.push(`  ! ${advice.error} (showing what is cached)`);
  }
  if (registry) {
    const covered = directTargets.length - registryMissing;
    lines.push(`Registry metadata: ${covered} of ${directTargets.length} direct versions cached${registry.stale ? `, ${registry.stale} stale` : ''}${registry.failed ? `, ${registry.failed} refresh failed` : ''}${registry.deferred ? `, ${registry.deferred} deferred by the 300-item per-run cap` : ''}${registry.notFound ? `, ${registry.notFound} version(s) returned 404 (deprecation unknown)` : ''}${!policy.allowed && registryMissing ? '; offline cache is incomplete' : ''}`);
    if (registry.error) lines.push(`  ! ${registry.error} (showing what is cached)`);
  }
  if (pnpmPartial) lines.push('Transitive dependencies were not checked because pnpm dependency traversal is unsupported.');

  if (only === 'vulnerable' || !only) {
    const limit = args.limit ?? 15;
    for (const f of findings.slice(0, limit)) {
      lines.push('', `${f.worst.malware ? 'MALWARE' : f.worst.severity.padEnd(8)} ${f.name}@${f.version}  ${f.direct ? '[direct]' : `[via ${f.by.slice(0, 3).join(', ')}${f.by.length > 3 ? ` +${f.by.length - 3}` : ''}]`}`);
      for (const v of [...f.vulns].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, 2)) lines.push(`  ${vulnLine(v, f.name, f.version)}`);
      if (f.vulns.length > 2) lines.push(`  … +${f.vulns.length - 2} more advisories`);
      lines.push(f.files.length
        ? `  exposed in ${f.files.length} file(s)${f.publicFiles ? `, ${f.publicFiles} with public records` : ''}: ${f.files.slice(0, 4).map((x) => `${x.path}:${x.line}`).join(', ')}${f.files.length > 4 ? ', …' : ''}`
        : '  no file in this repo imports it directly (it is a build or transitive dependency)');
    }
    if (findings.length > limit) lines.push('', `… ${findings.length - limit} more; raise limit`);
  }
  if ((only === 'deprecated' || !only) && deprecated.length) {
    lines.push('', 'Deprecated:');
    for (const { r, v, d } of deprecated.slice(0, 10)) lines.push(`  ${r.name}@${v}: ${d}${r.refCount ? ` (imported by ${r.refCount} file(s))` : ''}`);
  }
  if ((only === 'unused' || !only) && unused.length) {
    lines.push('', `Possibly unused production dependencies (a lead, never proof: check scripts, config and string imports): ${unused.slice(0, 15).map((r) => r.name).join(', ')}${unused.length > 15 ? ` +${unused.length - 15}` : ''}`);
  }
  if (!findings.length && advice && !partial && advice.checked > 0) lines.push('', 'No known vulnerabilities for the installed versions.');

  if (advice && (advice.checked || advice.stale || unresolvedDirect > 0)) {
    const cache = loadCache(out);
    cache.summary = { at: advice.oldestAt ?? Date.now(), validUntil: Math.min(advice.validUntil ?? Infinity, registry?.validUntil ?? Infinity), checked: advice.checked, vulnerable: findings.length, high: findings.filter((f) => ['CRITICAL', 'HIGH'].includes(f.worst.severity) || f.worst.malware).length, deprecated: deprecated.length, sig: store.stamp.stats?.depsLockSig ?? null, fingerprint: store.stamp.stats?.depsFingerprint ?? null, complete: !partial && advice.checked > 0 };
    saveCache(out, cache);
    if (findings.length || deprecated.length) lines.push('', CREDIT);
  }
  return lines.join('\n');
}

async function packageDetail({ root, out, store, memory, records, args, policy }) {
  const needle = args.package.toLowerCase();
  const rec = records.find((r) => r.name.toLowerCase() === needle) ?? records.find((r) => r.name.toLowerCase().includes(needle));
  if (!rec) return `No direct dependency matches "${args.package}". Transitive packages are checked by the list view (no argument).`;
  const lines = [`${rec.name}  ${rec.versions.join(', ') || 'version unknown (no lockfile)'}  ${rec.dev ? 'dev dependency' : 'production dependency'}  declared in ${rec.declaredIn.slice(0, 3).join(', ')}`];
  const prod = rec.refs.filter((r) => !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(r.path));
  lines.push(`imported by ${rec.refCount} file(s)${rec.refCount !== prod.length ? ` (${prod.length} outside tests)` : ''}${rec.flags.includes('no-refs') ? ' [no-refs: possibly unused, verify]' : ''}`);
  for (const r of rec.refs.slice(0, 12)) lines.push(`  ${r.path}:${r.line}`);
  if (rec.refCount > 12) lines.push(`  … ${rec.refCount - 12} more`);

  const targets = rec.versions.map((version) => ({ name: rec.name, version }));
  const force = args.refresh && policy.allowed;
    if (policy.allowed) {
      const cache = loadCache(out);
      cache.summary = null;
      saveCache(out, cache);
    }
  const advice = await advisoriesFor({ out, targets, online: policy.allowed, force });
  const registry = await registryFor({ out, targets, online: policy.allowed, force });
  if (!targets.length) lines.push('advisories: not checked; this direct dependency has no exact installed version in a supported lockfile.');
  const registryMissing = targets.filter((t) => !registry.byKey.has(`${t.name}@${t.version}`)).length;
  const registryStale = registry.stale ?? 0;
  lines.push(`Registry metadata: ${targets.length - registryMissing} of ${targets.length} package versions cached${registryStale ? `, ${registryStale} stale` : ''}${registry.failed ? `, ${registry.failed} refresh failed` : ''}${registry.deferred ? `, ${registry.deferred} deferred by the 300-item per-run cap` : ''}${registry.notFound ? `, ${registry.notFound} returned 404 (deprecation unknown)` : ''}${!policy.allowed && registryMissing ? '; offline cache is incomplete' : ''}`);
  if (registry.error) lines.push(`! ${registry.error} (showing what is cached)`);
  for (const t of targets) {
    const vulns = advice.byKey.get(`${t.name}@${t.version}`);
    if (!vulns) { lines.push(`advisories for ${t.version}: not checked. ${policy.why}`); continue; }
    lines.push(vulns.length ? `advisories for ${t.version}:` : advice.stale ? `advisories for ${t.version}: none in older cached data, but ${advice.staleKeys.size || advice.failedDetails ? 'the refresh failed' : advice.pendingDetails || advice.unresolvedDeferred ? 'the refresh was deferred by the per-run cap' : advice.expiredLookupsNotAttempted || advice.expiredDetailsNotAttempted ? 'cached data expired before it could be refreshed' : 'the refresh has not run yet'}, so this is not confirmed (partially checked)` : `no known advisories for ${t.version}`);
    for (const v of vulns.slice(0, 5)) lines.push(`  ${v.severity.padEnd(8)} ${vulnLine(v, t.name, t.version)}`);
    const meta = registry.byKey.get(`${t.name}@${t.version}`);
    if (meta?.deprecated) lines.push(`DEPRECATED ${t.version}: ${meta.deprecated}`);
    if (meta?.homepage) lines.push(`homepage: ${meta.homepage}`);
  }
  if (advice.error) lines.push(`! ${advice.error}`);
  if (args.docs !== undefined && args.docs !== false) {
    if (!rec.version) lines.push('', 'Docs need an installed version; there is no lockfile entry for this package.');
    else lines.push('', await docsFor({ out, memory, name: rec.name, version: rec.version, query: args.docs === true ? '' : String(args.docs), policy, refresh: Boolean(args.refresh) }));
  }
  if (lines.some((l) => /advisor|MALWARE/.test(l) && !/not checked|no known/.test(l))) lines.push('', CREDIT);
  return lines.join('\n');
}

/** `versionOf` for memory pins, backed by the map: installed versions, null when gone, undefined when unknown. */
export const versionOfFrom = (getStore) => (pkg) => {
  try {
    const s = getStore();
    if (!s) return undefined;
    const r = s.byId.get(`dep:${pkg}`);
    return r ? (r.versions.length ? r.versions : undefined) : null;
  } catch { return undefined; }
};

/** One line for the session brief. Reads the cache only: the brief never touches the network. */
export function depsSummary(out, store, now = Date.now()) {
  const records = depRecords(store);
  if (!records.length) return null;
  const dev = records.filter((r) => r.dev).length;
  const unused = records.filter((r) => r.flags.includes('no-refs')).length;
  const s = hasCache(out) ? loadCache(out).summary : null;
  let tail = 'map-wide advisory check unavailable (run `deps`; add --online to look it up)';
  if (s && s.fingerprint && s.fingerprint === (store.stamp.stats?.depsFingerprint ?? null) && (!s.complete || Number.isFinite(s.validUntil))) {
    const complete = s.complete && now < s.validUntil;
    tail = `${s.vulnerable} vulnerable (${s.high} high or critical), ${s.deprecated} deprecated, ${complete ? `checked ${ago(s.at)}` : s.checked ? `partially checked (oldest data ${ago(s.at)})` : 'partially checked (no package versions checked)'}`;
  }
  else if (s) tail = 'dependency manifests or lockfiles changed since the last advisory check, or the saved summary is legacy';
  return `Dependencies: ${records.length} direct (${dev} dev)${unused ? `, ${unused} possibly unused` : ''}; ${tail}`;
}
