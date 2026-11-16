// The only place map-it-all touches the network, and it is off unless the user turned it on.
//
// Who can turn it on: the user, by `--online` for one run, `"network": true` in map-it-all.config.json,
// or MAP_IT_ALL_ONLINE=1. An agent cannot: a tool argument only asks for a refresh, and the answer is
// still "no" while the policy says off. MAP_IT_ALL_OFFLINE=1 wins over everything (CI, air-gapped).
//
// OSV receives package/version queries and advisory IDs in detail URL paths. npm and docs hosts receive
// requested URLs, our remote IP and ordinary HTTP/TLS metadata, including this tool's user-agent.
// Responses are capped and treated as untrusted; docs destinations are restricted to public HTTPS.

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
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
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) {
      const mapped = l.slice(7);
      if (net.isIP(mapped) === 4) return privateAddress(mapped);
      const parts = mapped.split(':');
      if (parts.length === 2 && parts.every((p) => /^[\da-f]{1,4}$/i.test(p))) return privateAddress(`${parseInt(parts[0], 16) >> 8}.${parseInt(parts[0], 16) & 255}.${parseInt(parts[1], 16) >> 8}.${parseInt(parts[1], 16) & 255}`);
      return true;
    }
    // net.isIP validates syntax; expand compression and embedded IPv4 before testing CIDR prefixes.
    const words = l.split('::');
    const parseSide = (side) => side ? side.split(':').flatMap((part) => {
      if (!part.includes('.')) return [parseInt(part, 16)];
      const octets = part.split('.').map(Number);
      return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    }) : [];
    const left = parseSide(words[0]);
    const right = words.length === 2 ? parseSide(words[1]) : [];
    const expanded = words.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
    const [firstWord, secondWord] = expanded;
    return firstWord < 0x2000 || firstWord >= 0x4000 || (firstWord === 0x2001 && (secondWord <= 0x01ff || secondWord === 0x0db8)) || l.startsWith('2002:') || firstWord === 0x3fff;
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

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`request timed out after ${ms} ms`)), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/**
 * GET or POST with a timeout, a size cap and manual redirects (at most 3). `trusted` is for the fixed
 * service endpoints (OSV, npm registry, or a test server). Every redirect is independently resolved;
 * untrusted destinations require public HTTPS addresses.
 */
export async function fetchText(url, { method = 'GET', body, headers = {}, timeoutMs = 8000, maxBytes = 1_000_000, trusted = false, resolve = lookup } = {}) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error(`request timed out after ${timeoutMs} ms`);
  let activeRequest;
  const timer = setTimeout(() => activeRequest?.destroy(timeoutError()), timeoutMs);
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw timeoutError();
    return budget;
  };
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      remaining();
      const u = new URL(current);
      const sameOrigin = trusted && u.origin === new URL(url).origin;
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!sameOrigin) {
        if (u.protocol !== 'https:') throw new Error(`refusing non-https URL (${u.protocol}//${u.host})`);
        if (host === 'localhost' || /\.(localhost|local|internal|lan)$/.test(host)) throw new Error(`refusing local host ${host}`);
      }
      const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await withTimeout(resolve(host, { all: true }), remaining());
      remaining(); // Ignore a DNS result that arrived after the total deadline.
      if (!addrs.length || (!sameOrigin && addrs.some((a) => privateAddress(a.address)))) throw new Error(`refusing ${host}: not a public address`);
      const chosen = addrs[0];
      if (u.protocol !== 'https:' && !(sameOrigin && u.protocol === 'http:')) throw new Error('refusing non-https URL');
      const transport = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const res = await new Promise((resolve, reject) => {
        const req = activeRequest = transport({ protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: hop === 0 ? method : 'GET', headers: { host: u.host, 'user-agent': `map-it-all/${VERSION}`, ...headers }, timeout: remaining(),
          // The socket connects to this resolved address while TLS verifies the original hostname.
          lookup: (_hostname, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
        }, (response) => {
          const chunks = []; let size = 0;
          response.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) req.destroy(new Error(`response exceeds ${maxBytes} bytes`)); else chunks.push(chunk); });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', reject);
        });
        req.on('timeout', () => req.destroy(timeoutError()));
        req.on('error', reject);
        if (hop === 0 && body !== undefined) req.write(body);
        req.end();
      });
      activeRequest = undefined;
      remaining();
      const next = res.headers.location;
      if (res.status >= 300 && res.status < 400 && next) { current = new URL(next, u).href; continue; }
      if (res.status < 200 || res.status >= 300) { const e = new Error(`${res.status} from ${u.host}`); e.status = res.status; throw e; }
      return { text: res.text, type: res.headers['content-type'] ?? '', url: u.href };
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(timer);
  }
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
