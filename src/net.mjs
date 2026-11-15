// The only place map-it-all touches the network, and it is off unless the user turned it on.
//
// Who can turn it on: the user, by `--online` for one run, `"network": true` in map-it-all.config.json,
// or MAP_IT_ALL_ONLINE=1. An agent cannot: a tool argument only asks for a refresh, and the answer is
// still "no" while the policy says off. MAP_IT_ALL_OFFLINE=1 wins over everything (CI, air-gapped).
//
// What leaves the machine: package names and versions, nothing else. No paths, no code, no repo name.
// What comes back is untrusted text: it is size-capped, stripped of control characters, and the
// URLs a package author controls (docs links) may only reach public https hosts.

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PKG_ROOT } from './context.mjs';

const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

export const OFFLINE_HINT = 'Network lookups are off. Allow them for one run with --online, or permanently with "network": true in map-it-all.config.json.';

export function networkPolicy({ config, allow = false, env = process.env } = {}) {
  if (env.MAP_IT_ALL_OFFLINE === '1') return { allowed: false, why: 'MAP_IT_ALL_OFFLINE=1 is set.' };
  if (allow || config?.network === true || env.MAP_IT_ALL_ONLINE === '1') return { allowed: true, why: '' };
  return { allowed: false, why: OFFLINE_HINT };
}

/** Strip control characters and collapse whitespace: remote text is data, and must stay one tidy line. */
export const clean = (s, max = 200) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function privateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return privateAddress(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true; // not an address we understand: fail closed
}

/** https only, and the host must resolve to public addresses (a package's homepage is attacker-controlled). */
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`refusing non-https URL (${u.protocol}//${u.host})`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal|lan)$/.test(host)) throw new Error(`refusing local host ${host}`);
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error(`refusing ${host}: not a public address`);
  return u;
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > maxBytes) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/**
 * GET or POST with a timeout, a size cap and manual redirects (at most 3). `trusted` is for the fixed
 * service endpoints (OSV, npm registry, or a test server); everything else must be a public https URL.
 */
export async function fetchText(url, { method = 'GET', body, headers = {}, timeoutMs = 8000, maxBytes = 1_000_000, trusted = false } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const sameOrigin = trusted && new URL(current).origin === new URL(url).origin;
    const u = sameOrigin ? new URL(current) : await assertPublicUrl(current);
    const res = await fetch(u, {
      method: hop === 0 ? method : 'GET',
      body: hop === 0 ? body : undefined,
      headers: { 'user-agent': `map-it-all/${VERSION}`, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) { current = new URL(next, u).href; continue; }
    if (!res.ok) { const e = new Error(`${res.status} from ${u.host}`); e.status = res.status; throw e; }
    return { text: await readCapped(res, maxBytes), type: res.headers.get('content-type') ?? '', url: u.href };
  }
  throw new Error('too many redirects');
}

export async function getJson(url, options) {
  const r = await fetchText(url, { ...options, headers: { accept: 'application/json', ...options?.headers } });
  return JSON.parse(r.text);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}
