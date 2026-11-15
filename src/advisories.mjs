// Advisories and deprecations for exact installed versions, cached on disk.
//
//   OSV (https://osv.dev)          which vulnerabilities affect name@version: one batched request for the
//                                  whole lockfile, then one request per distinct advisory id
//   npm registry                   whether a version is deprecated, plus its homepage and repository
//
// The cache (.map-it-all/deps-cache.json) is keyed by name@version, so a lockfile that did not change
// costs no requests, and a bumped package costs one. Nothing here runs during `build`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clean, getJson, pool } from './net.mjs';

const OSV = () => process.env.MAP_IT_ALL_OSV_URL || 'https://api.osv.dev';
const NPM = () => process.env.MAP_IT_ALL_NPM_URL || 'https://registry.npmjs.org';
const TTL = { osv: 24 * 36e5, vuln: 7 * 24 * 36e5, npm: 7 * 24 * 36e5 };
const BATCH = 500;
const MAX_NEW_VULNS = 300;
const MAX_REGISTRY = 300;

// ---------- cache ----------

const cacheFile = (out) => path.join(out, 'deps-cache.json');

export function loadCache(out) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(out), 'utf8'));
    if (c.v === 1) return c;
  } catch { /* none yet */ }
  return { v: 1, osv: {}, vulns: {}, npm: {}, summary: null };
}

export function saveCache(out, cache) {
  mkdirSync(out, { recursive: true });
  const tmp = `${cacheFile(out)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, cacheFile(out));
}

export const hasCache = (out) => existsSync(cacheFile(out));
const fresh = (entry, ttl, now) => entry && now - entry.at < ttl;

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
      (res.results ?? []).forEach((r, j) => {
        const { key, q } = slice[j];
        out.set(key, [...(out.get(key) ?? []), ...(r.vulns ?? []).map((v) => v.id)]);
        if (r.next_page_token) next.push({ key, q: { ...q, page_token: r.next_page_token } });
      });
    }
    todo = next;
  }
  return out;
}

/**
 * Advisories for each `{ name, version }`. Cached entries are used while fresh; with `online` the rest
 * are fetched. Returns `{ byKey: Map(name@version -> vuln[]), checked, missing, error }`.
 */
export async function advisoriesFor({ out, targets, online, force = false }) {
  const now = Date.now();
  const cache = loadCache(out);
  const unique = [...new Map(targets.filter((t) => t.version).map((t) => [`${t.name}@${t.version}`, t])).values()];
  const stale = unique.filter((t) => force || !fresh(cache.osv[`${t.name}@${t.version}`], TTL.osv, now));
  let error = null;
  if (online && stale.length) {
    try {
      const found = await osvBatch(stale);
      for (const [key, ids] of found) cache.osv[key] = { ids: [...new Set(ids)], at: now };
      const need = [...new Set([...found.values()].flat())].filter((id) => !fresh(cache.vulns[id], TTL.vuln, now)).slice(0, MAX_NEW_VULNS);
      await pool(need, 8, async (id) => {
        try { cache.vulns[id] = slimVuln(await getJson(`${OSV()}/v1/vulns/${encodeURIComponent(id)}`, { trusted: true }), now); } catch (e) { error ??= `advisory ${id}: ${e.message}`; }
      });
    } catch (e) { error = `OSV lookup failed: ${e.message}`; }
    saveCache(out, cache);
  }
  const byKey = new Map();
  let missing = 0;
  let oldestAt = now;
  for (const t of unique) {
    const entry = cache.osv[`${t.name}@${t.version}`];
    if (!entry) { missing++; continue; }
    oldestAt = Math.min(oldestAt, entry.at);
    byKey.set(`${t.name}@${t.version}`, entry.ids.map((id) => cache.vulns[id]).filter((v) => v && !v.withdrawn));
  }
  return { byKey, checked: unique.length - missing, missing, error, oldestAt };
}

// ---------- npm registry ----------

const registryUrl = (name, version) => `${NPM()}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;

/** Deprecation notice, homepage and repository for each direct dependency version. */
export async function registryFor({ out, targets, online, force = false }) {
  const now = Date.now();
  const cache = loadCache(out);
  const unique = [...new Map(targets.filter((t) => t.version).map((t) => [`${t.name}@${t.version}`, t])).values()];
  let error = null;
  if (online) {
    const stale = unique.filter((t) => force || !fresh(cache.npm[`${t.name}@${t.version}`], TTL.npm, now)).slice(0, MAX_REGISTRY);
    await pool(stale, 8, async (t) => {
      try {
        const d = await getJson(registryUrl(t.name, t.version), { trusted: true });
        const repo = typeof d.repository === 'string' ? d.repository : d.repository?.url;
        cache.npm[`${t.name}@${t.version}`] = { deprecated: d.deprecated ? clean(d.deprecated, 200) : null, homepage: clean(d.homepage, 200) || null, repo: clean(repo, 200) || null, at: now };
      } catch (e) { if (e.status !== 404) error ??= `registry ${t.name}: ${e.message}`; }
    });
    saveCache(out, cache);
  }
  return { byKey: new Map(unique.map((t) => [`${t.name}@${t.version}`, cache.npm[`${t.name}@${t.version}`]]).filter(([, v]) => v)), error, cache };
}
