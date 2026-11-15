// Advisories and deprecations for exact installed versions, cached on disk.
//
//   OSV (https://osv.dev)          which vulnerabilities affect name@version: one batched request for the
//                                  whole lockfile, then one request per distinct advisory id
//   npm registry                   whether a version is deprecated, plus its homepage and repository
//
// The cache (.map-it-all/deps-cache.json) is keyed by name@version: while its entries are fresh a lockfile
// that did not change costs no requests, and a bumped package costs one lookup. Advisory details that
// could not be fetched are retried on the next online run. Nothing here runs during `build`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clean, getJson, pool } from './net.mjs';

const OSV = () => process.env.MAP_IT_ALL_OSV_URL || 'https://api.osv.dev';
const NPM = () => process.env.MAP_IT_ALL_NPM_URL || 'https://registry.npmjs.org';
const TTL = { osv: 24 * 36e5, vuln: 7 * 24 * 36e5, npm: 7 * 24 * 36e5 };
export const CACHE_TTL = TTL;
const BATCH = 500;
export const MAX_NEW_VULNS = 300;
export const MAX_REGISTRY = 300;

// ---------- cache ----------

const cacheFile = (out) => path.join(out, 'deps-cache.json');

export function loadCache(out) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(out), 'utf8'));
    if (c.v === 1) return c;
  } catch { /* none yet */ }
  return { v: 1, osv: {}, vulns: {}, npm: {}, summary: null, osvFailed: {}, tried: {}, deferred: {}, npmTried: {} };
}

export function saveCache(out, cache) {
  mkdirSync(out, { recursive: true });
  const tmp = `${cacheFile(out)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, cacheFile(out));
}

export const hasCache = (out) => existsSync(cacheFile(out));

/** When the newest advisory lookup was cached, and whether the 24 h advisory window has passed. */
export function cacheAge(out, now = Date.now()) {
  if (!hasCache(out)) return { exists: false };
  const entries = Object.values(loadCache(out).osv);
  const times = entries.map((e) => e.at).filter(Number.isFinite);
  if (!times.length) return { exists: true, at: null, ageMs: null, count: entries.length, stale: entries.length, expired: true };
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  // Same rule as `fresh()`: an entry is usable only while strictly younger than the TTL.
  const stale = entries.filter((e) => !fresh(e, TTL.osv, now)).length;
  return { exists: true, at: newest, ageMs: Math.max(0, now - newest), oldestAgeMs: Math.max(0, now - oldest), count: entries.length, stale, expired: stale > 0 };
}
const fresh = (entry, ttl, now) => entry && Number.isFinite(entry.at) && now - entry.at < ttl;

// ---------- versions and CVSS ----------

/** Compare dotted versions numerically, ignoring pre-release tags (good enough to order fixed versions). */
export function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const W = { AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 }, CIA: { H: 0.56, L: 0.22, N: 0 } };

/** CVSS 3.x base score from a vector string, or null if it is not a 3.x vector. */
export function cvss3(vector) {
  if (!/^CVSS:3\.[01]\//.test(vector ?? '')) return null;
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':')));
  const changed = m.S === 'C';
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const [av, ac, ui, c, i, a] = [W.AV[m.AV], W.AC[m.AC], W.UI[m.UI], W.CIA[m.C], W.CIA[m.I], W.CIA[m.A]];
  if ([pr, av, ac, ui, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const raw = Math.min((changed ? 1.08 : 1) * (impact + 8.22 * av * ac * pr * ui), 10);
  const n = Math.round(raw * 100000); // the spec's Roundup, immune to float noise
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
}

export const ratingOf = (score) => (score >= 9 ? 'CRITICAL' : score >= 7 ? 'HIGH' : score >= 4 ? 'MODERATE' : score > 0 ? 'LOW' : 'NONE');
export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'UNKNOWN', 'NONE'];

/** One OSV record reduced to what an agent needs, with every remote string cleaned and capped. */
export function slimVuln(v, now = Date.now()) {
  const label = String(v.database_specific?.severity ?? '').toUpperCase().replace('MEDIUM', 'MODERATE');
  let score = null;
  for (const s of v.severity ?? []) score ??= cvss3(s.score);
  const severity = SEVERITY_ORDER.includes(label) ? label : score !== null ? ratingOf(score) : 'UNKNOWN';
  const fixed = {};
  for (const a of v.affected ?? []) {
    if (a.package?.ecosystem !== 'npm') continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) (fixed[a.package.name] ??= []).push(clean(e.fixed, 40));
  }
  return {
    id: clean(v.id, 60), aliases: (v.aliases ?? []).slice(0, 4).map((x) => clean(x, 40)),
    summary: clean(v.summary || String(v.details ?? '').split('\n')[0], 140), severity, score,
    malware: /^MAL-/.test(v.id ?? ''), withdrawn: Boolean(v.withdrawn), fixed, at: now,
  };
}

/** The smallest fixed version above the installed one, if the advisory names any. */
export function fixedIn(vuln, name, version) {
  const list = (vuln.fixed?.[name] ?? []).filter((f) => cmpVersion(f, version) > 0).sort(cmpVersion);
  return list[0] ?? null;
}

// ---------- OSV ----------

async function osvBatch(targets) {
  const out = new Map(); // key -> [ids]
  let todo = targets.map((t) => ({ key: `${t.name}@${t.version}`, q: { package: { name: t.name, ecosystem: 'npm' }, version: t.version } }));
  for (let round = 0; round < 4 && todo.length; round++) {
    const next = [];
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const res = await getJson(`${OSV()}/v1/querybatch`, { method: 'POST', body: JSON.stringify({ queries: slice.map((s) => s.q) }), headers: { 'content-type': 'application/json' }, trusted: true, timeoutMs: 20000, maxBytes: 20_000_000 });
      if (!Array.isArray(res?.results) || res.results.length !== slice.length) {
        throw new Error(`OSV querybatch returned ${Array.isArray(res?.results) ? `${res.results.length} results` : 'no results array'} for ${slice.length} queries`);
      }
      res.results.forEach((r, j) => {
        const { key, q } = slice[j];
        out.set(key, [...(out.get(key) ?? []), ...(r.vulns ?? []).map((v) => v.id)]);
        if (r.next_page_token) next.push({ key, q: { ...q, page_token: r.next_page_token } });
      });
    }
    todo = next;
  }
  if (todo.length) throw new Error(`OSV querybatch pagination still had ${todo.length} page(s) after 4 rounds`);
  return out;
}

/**
 * Advisories for each `{ name, version }`. Cached entries are used while fresh; with `online` the rest
 * are fetched. Returns `{ byKey: Map(name@version -> vuln[]), checked, missing, error }`.
 */
export async function advisoriesFor({ out, targets, online, force = false, now = Date.now() }) {
  const cache = loadCache(out);
  const unique = [...new Map(targets.filter((t) => t.version).map((t) => [`${t.name}@${t.version}`, t])).values()];
  cache.osvFailed ??= {};
  const stale = unique.filter((t) => force || cache.osvFailed[`${t.name}@${t.version}`] || !fresh(cache.osv[`${t.name}@${t.version}`], TTL.osv, now));
  const idsOf = (t) => cache.osv[`${t.name}@${t.version}`]?.ids ?? [];
  const staleKeys = new Set(Object.keys(cache.osvFailed).filter((key) => unique.some((t) => key === `${t.name}@${t.version}`)));
  let error = null;
  cache.tried ??= {}; // id -> when its detail request last failed (also the rotation cursor)
  cache.deferred ??= {}; // id -> when it was wanted but left out by the per-run cap
  if (online) {
    if (stale.length) {
      try {
        const found = await osvBatch(stale);
        for (const t of stale) {
          const key = `${t.name}@${t.version}`;
          if (found.has(key)) { cache.osv[key] = { ids: [...new Set(found.get(key))], at: now }; delete cache.osvFailed[key]; staleKeys.delete(key); }
        }
      } catch (e) {
        error = `OSV lookup failed: ${e.message}`;
        for (const t of stale) { const key = `${t.name}@${t.version}`; cache.osvFailed[key] = now; staleKeys.add(key); }
        saveCache(out, cache); // persist the retry marker before any later operation can fail
      }
    }
    // One queue of every advisory id that needs a detail request: ids with no record and ids whose record
    // expired (or all of them with `force`). The id whose last attempt (a failure stamps `tried`, a success
    // stamps the record) is oldest goes first, so never-attempted ids lead and ids that keep failing rotate
    // to the back instead of starving the rest of the 300-per-run cap. An old record is kept if its refresh fails.
    const ids = [...new Set(unique.flatMap(idsOf))];
    const last = (id) => Math.max(cache.tried[id] ?? 0, cache.vulns[id]?.at ?? 0);
    const wanted = ids.filter((id) => force || cache.tried[id] || cache.deferred[id] || !fresh(cache.vulns[id], TTL.vuln, now)).sort((a, b) => last(a) - last(b) || (a < b ? -1 : 1));
    const need = wanted.slice(0, MAX_NEW_VULNS);
    const capped = new Set(wanted.slice(MAX_NEW_VULNS));
    for (const id of ids) {
      if (capped.has(id)) cache.deferred[id] = now;
    }
    for (const id of need) delete cache.deferred[id];
    await pool(need, 8, async (id) => {
      try { cache.vulns[id] = slimVuln(await getJson(`${OSV()}/v1/vulns/${encodeURIComponent(id)}`, { trusted: true }), now); delete cache.tried[id]; delete cache.deferred[id]; } catch (e) { cache.tried[id] = now; delete cache.deferred[id]; error ??= `advisory ${id}: ${e.message}`; }
    });
    saveCache(out, cache);
  }
  const byKey = new Map();
  let missing = 0;
  let oldestAt = now;
  const unresolved = new Set();
  const expiredDetailsNotAttempted = new Set();
    const staleIds = new Set(); // cached records with a failed refresh or a cap deferral
  const failedIds = new Set();
    const deferredIds = new Set();
  for (const t of unique) {
    const entry = cache.osv[`${t.name}@${t.version}`];
    if (!entry) { missing++; continue; }
    if (Number.isFinite(entry.at)) oldestAt = Math.min(oldestAt, entry.at);
    const vulns = [];
    for (const id of entry.ids) {
      const v = cache.vulns[id];
      if (v) {
        if (!fresh(v, TTL.vuln, now) && !cache.tried[id] && !cache.deferred[id]) expiredDetailsNotAttempted.add(id);
          if (cache.deferred[id]) { staleIds.add(id); deferredIds.add(id); }
          else if (cache.tried[id]) { staleIds.add(id); failedIds.add(id); }
        if (!v.withdrawn) vulns.push(v);
        continue;
      }
      unresolved.add(id);
      vulns.push({ id, aliases: [], summary: 'details not fetched yet; run again online', severity: 'UNKNOWN', score: null, malware: false, withdrawn: false, fixed: {}, unresolved: true });
    }
    byKey.set(`${t.name}@${t.version}`, vulns);
  }
  const unresolvedDeferred = [...unresolved].filter((id) => cache.deferred[id]).length;
  const unresolvedFailed = [...unresolved].filter((id) => !cache.deferred[id] && cache.tried[id]).length;
  const unresolvedPending = unresolved.size - unresolvedFailed - unresolvedDeferred;
  const failedDetails = failedIds.size;
  const pendingDetails = deferredIds.size;
  const expiredLookupsNotAttempted = unique.filter((t) => {
    const key = `${t.name}@${t.version}`;
    return !fresh(cache.osv[key], TTL.osv, now) && !cache.osvFailed[key];
  }).length;
  const parts = [];
  if (staleKeys.size) parts.push(`${staleKeys.size} package lookup(s) failed to refresh`);
  if (expiredLookupsNotAttempted) parts.push(`${expiredLookupsNotAttempted} expired package lookup(s) not attempted`);
  if (unresolvedFailed) parts.push(`${unresolvedFailed} advisory detail(s) failed to fetch`);
  if (unresolvedDeferred) parts.push(`${unresolvedDeferred} advisory detail(s) deferred by the ${MAX_NEW_VULNS}-item per-run cap`);
  if (unresolvedPending) parts.push(`${unresolvedPending} missing advisory detail(s) not fetched yet`);
  if (failedDetails) parts.push(`${failedDetails} cached advisory detail(s) failed to refresh`);
  if (pendingDetails) parts.push(`${pendingDetails} cached advisory detail(s) deferred by the ${MAX_NEW_VULNS}-item per-run cap`);
  if (expiredDetailsNotAttempted.size) parts.push(`${expiredDetailsNotAttempted.size} expired cached advisory detail(s) not attempted`);
  if (!error && parts.length) error = parts.join('; ');
  const validUntil = Math.min(...unique.flatMap((t) => {
    const entry = cache.osv[`${t.name}@${t.version}`];
    return Number.isFinite(entry?.at) ? [entry.at + TTL.osv, ...entry.ids.map((id) => cache.vulns[id]?.at + TTL.vuln).filter(Number.isFinite)] : [];
  }), Infinity);
  return { byKey, checked: unique.length - missing, missing, unresolved: unresolved.size, unresolvedFailed, unresolvedDeferred, unresolvedPending, staleKeys, staleDetails: staleIds.size, failedDetails, pendingDetails, expiredLookupsNotAttempted, expiredDetailsNotAttempted: expiredDetailsNotAttempted.size, stale: staleKeys.size + staleIds.size + expiredLookupsNotAttempted + expiredDetailsNotAttempted.size, error, oldestAt, validUntil };
}

// ---------- npm registry ----------

const registryUrl = (name, version) => `${NPM()}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;

/**
 * Deprecation notice, homepage and repository for each direct dependency version. At most MAX_REGISTRY
 * requests per run, oldest attempt first (a failure stamps `npmTried`, a success stamps the entry), so a
 * target that keeps failing rotates behind the others and cannot starve them. Returns `failed` (versions whose
 * last refresh failed, kept across offline runs), `deferred` (wanted this run but over the cap) and `notFound`.
 */
export async function registryFor({ out, targets, online, force = false, now = Date.now() }) {
  const cache = loadCache(out);
  cache.npmTried ??= {};
  cache.npmDeferred ??= {};
  const unique = [...new Map(targets.filter((t) => t.version).map((t) => [`${t.name}@${t.version}`, t])).values()];
  const keyOf = (t) => `${t.name}@${t.version}`;
  let error = null;
  let deferred = 0;
  if (online) {
    const last = (t) => Math.max(cache.npmTried[keyOf(t)] ?? 0, cache.npm[keyOf(t)]?.at ?? 0);
    const needs = unique.filter((t) => force || cache.npmTried[keyOf(t)] || cache.npmDeferred[keyOf(t)] || !fresh(cache.npm[keyOf(t)], TTL.npm, now)).sort((a, b) => last(a) - last(b) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const attempt = needs.slice(0, MAX_REGISTRY);
    for (const t of needs.slice(MAX_REGISTRY)) cache.npmDeferred[keyOf(t)] = now;
    for (const t of attempt) delete cache.npmDeferred[keyOf(t)];
    await pool(attempt, 8, async (t) => {
      try {
        const d = await getJson(registryUrl(t.name, t.version), { trusted: true });
        const repo = typeof d.repository === 'string' ? d.repository : d.repository?.url;
        cache.npm[keyOf(t)] = { deprecated: d.deprecated ? clean(d.deprecated, 200) : null, homepage: clean(d.homepage, 200) || null, repo: clean(repo, 200) || null, at: now };
        delete cache.npmTried[keyOf(t)];
        delete cache.npmDeferred[keyOf(t)];
      } catch (e) {
        delete cache.npmDeferred[keyOf(t)];
        if (e.status === 404) { cache.npm[keyOf(t)] = { deprecated: null, homepage: null, repo: null, notFound: true, at: now }; delete cache.npmTried[keyOf(t)]; }
        else { cache.npmTried[keyOf(t)] = now; error ??= `registry ${t.name}: ${e.message}`; }
      }
    });
    saveCache(out, cache);
  }
  deferred = unique.filter((t) => cache.npmDeferred[keyOf(t)]).length;
  const failed = unique.filter((t) => !cache.npmDeferred[keyOf(t)] && cache.npmTried[keyOf(t)]).length;
  const notFound = unique.filter((t) => cache.npm[keyOf(t)]?.notFound).length;
  const stale = unique.filter((t) => cache.npm[keyOf(t)] && !fresh(cache.npm[keyOf(t)], TTL.npm, now)).length;
  const validUntil = Math.min(...unique.map((t) => Number.isFinite(cache.npm[keyOf(t)]?.at) ? cache.npm[keyOf(t)].at + TTL.npm : Infinity), Infinity);
  return { byKey: new Map(unique.map((t) => [keyOf(t), cache.npm[keyOf(t)]]).filter(([, v]) => v)), error, cache, failed, deferred, notFound, stale, validUntil };
}
