// Read side of the map: loads .map-it-all/ into indexes and answers connection questions.
// Used by the MCP server and the CLI; no I/O beyond reading the JSON the builder wrote.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isTestPath } from './context.mjs';

const SKIP = new Set(['stamp.json', 'imports.json', 'files.json', 'handoff.json', 'deps-cache.json']);

/** Flags that make a record a cleanup lead (the rest explain or inform). */
export const LEAD_FLAGS = new Set([
  'no-refs', 'test-only', 'unmounted', 'not-in-ExpoModulesPackageList', 'no-kotlin-module', 'target-missing',
  'outside-runner-globs', 'history-only-refs', 'read-not-set-in-checkout', 'knip-unused-file', 'dead-path',
]);

const stampTime = (out) => { try { return statSync(path.join(out, 'stamp.json')).mtimeMs; } catch { return 0; } };

/**
 * Load the map. A background build may replace files while we read, so check that the stamp did not
 * change underneath us and retry (briefly) if it did. Returns null when there is no map yet.
 */
export function loadStore(out) {
  for (let attempt = 0; ; attempt++) {
    const before = stampTime(out);
    try {
      const store = loadOnce(out);
      if (stampTime(out) === before) return store;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
    if (attempt >= 3) return loadOnce(out);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  }
}

function loadOnce(out) {
  if (!existsSync(path.join(out, 'stamp.json')) || !existsSync(path.join(out, 'imports.json'))) return null;
  const stamp = JSON.parse(readFileSync(path.join(out, 'stamp.json'), 'utf8'));
  const records = [];
  for (const f of readdirSync(out)) {
    if (!f.endsWith('.json') || SKIP.has(f)) continue;
    for (const r of JSON.parse(readFileSync(path.join(out, f), 'utf8')).records ?? []) records.push({ ...r, file: f });
  }
  const importedBy = new Map();
  const imports = new Map();
  for (const [target, list] of Object.entries(JSON.parse(readFileSync(path.join(out, 'imports.json'), 'utf8')).index)) {
    importedBy.set(target, list.map((e) => ({ path: e.slice(0, e.lastIndexOf(':')), line: Number(e.slice(e.lastIndexOf(':') + 1)) })));
    for (const e of list) {
      const from = e.slice(0, e.lastIndexOf(':'));
      if (!imports.has(from)) imports.set(from, []);
      imports.get(from).push(target);
    }
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const byPath = new Map();
  for (const r of records) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const files = new Set([...importedBy.keys(), ...imports.keys(), ...byPath.keys()]);
  return { out, stamp, records, byId, byPath, importedBy, imports, files };
}

/** A file path or record id, exact or by unique substring. */
export function resolveTarget(store, needle) {
  const n = needle.trim().replaceAll('\\', '/');
  if (store.files.has(n)) return { path: n };
  if (store.byId.has(n)) return { path: store.byId.get(n).path, record: store.byId.get(n) };
  const lower = n.toLowerCase();
  const paths = [...store.files].filter((p) => p.toLowerCase().endsWith(lower));
  const loose = paths.length ? paths : [...store.files].filter((p) => p.toLowerCase().includes(lower));
  if (loose.length === 1) return { path: loose[0] };
  const ids = store.records.filter((r) => r.id.toLowerCase().includes(lower) || r.name.toLowerCase() === lower);
  if (!loose.length && ids.length === 1) return { path: ids[0].path, record: ids[0] };
  const options = [...loose.slice(0, 8), ...ids.slice(0, 8).map((r) => r.id)];
  return options.length ? { ambiguous: options } : null;
}

export const flagsOf = (r) => `[${r.flags.join(',') || 'ok'}]${r.public ? ' public' : ''}`;

/** Records filtered by text, kind, flag and publicness, as compact lines. */
export function findRecords(store, { query = '', kind, flag, public: pub, limit = 20 } = {}) {
  const q = query.toLowerCase();
  const hits = store.records.filter((r) => (!kind || r.kind === kind) && (!flag || r.flags.includes(flag)) && (pub === undefined || Boolean(r.public) === pub)
    && (!q || r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)));
  const lines = [`${hits.length} match(es)${hits.length > limit ? `, showing ${limit}` : ''}`];
  for (const r of hits.slice(0, limit)) {
    lines.push(`${r.id}  ${r.path}:${r.line}  ${flagsOf(r)}  refs ${r.refCount} (production ${r.prodRefCount})`);
    for (const x of r.refs.slice(0, 5)) lines.push(`    ${x.path}:${x.line} ${x.how}`);
    if (r.refCount > 5) lines.push(`    … ${r.refCount - 5} more`);
  }
  return lines.join('\n');
}

const mark = (p) => (isTestPath(p) ? ' [test]' : '');

/**
 * Edges around a file. `in` = who depends on it (blast radius), `out` = what it depends on,
 * `callers` = other files that reference its records by name (routes, Convex functions, native modules).
 */
export function connections(store, start, { direction = 'both', depth = 1, max = 60, recordId } = {}) {
  const edges = [];
  const walk = (dir) => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next = [];
      for (const f of frontier) {
        const list = dir === 'in' ? (store.importedBy.get(f) ?? []).map((e) => ({ p: e.path, line: e.line })) : (store.imports.get(f) ?? []).map((p) => ({ p, line: 0 }));
        for (const { p, line } of list) {
          edges.push({ dir, depth: d, from: dir === 'in' ? p : f, to: dir === 'in' ? f : p, other: p, line });
          if (!seen.has(p)) { seen.add(p); next.push(p); }
        }
      }
      frontier = next;
    }
  };
  if (direction === 'in' || direction === 'both') walk('in');
  if (direction === 'out' || direction === 'both') walk('out');
  // Callers are by-name references (api.x.y, URL literals, native names…). Plain imports are already in IN.
  const callers = [];
  const notStored = [];
  for (const r of store.byPath.get(start) ?? []) {
    if (recordId && r.id !== recordId) continue;
    for (const ref of r.refs) {
      if (ref.how === 'import' || ref.how === 'import-via-copy') continue;
      callers.push({ record: r.id, path: ref.path, line: ref.line, how: ref.how, flags: r.flags, public: r.public });
    }
    if (r.refCount > r.refs.length) notStored.push(`${r.id}: ${r.refCount - r.refs.length} more refs not stored`);
  }
  return { edges, callers, notStored, truncated: edges.length > max };
}

export function formatConnections(store, start, opts = {}) {
  const { max = 60 } = opts;
  const { edges, callers, notStored } = connections(store, start, opts);
  const recs = store.byPath.get(start) ?? [];
  const lines = [`${start}${mark(start)}  (${recs.length} map records; direction ${opts.direction ?? 'both'}, depth ${opts.depth ?? 1})`];
  const section = (title, dir) => {
    const list = edges.filter((e) => e.dir === dir);
    if (!list.length) return;
    lines.push('', `${title} (${list.length}${list.length > max ? `, showing ${max}` : ''})`);
    for (const e of list.slice(0, max)) lines.push(`  d${e.depth}  ${e.other}${e.line ? `:${e.line}` : ''}${mark(e.other)}`);
  };
  section('IN: depends on this file (blast radius)', 'in');
  section('OUT: this file depends on', 'out');
  if (callers.length) {
    lines.push('', `CALLERS of its map records (${callers.length}${callers.length > max ? `, showing ${max}` : ''})`);
    for (const c of callers.slice(0, max)) lines.push(`  ${c.record} <- ${c.path}:${c.line} (${c.how})${mark(c.path)}${c.public ? ' public' : ''}`);
    for (const n of notStored) lines.push(`  (${n})`);
  } else if (opts.recordId) {
    const r = store.byId.get(opts.recordId);
    if (r) lines.push('', `No by-name callers recorded for ${r.id} ${r.flags.length ? `[${r.flags.join(',')}]` : ''}${r.public ? ' public: installed or external clients may still call it' : ''}`);
  }
  if (lines.length === 1) lines.push('', 'No imports, importers or callers recorded for this file.');
  return lines.join('\n');
}

export function mermaid(store, start, opts = {}) {
  const { edges, callers } = connections(store, start, opts);
  const ids = new Map([[start, 'n0']]);
  const id = (p) => { if (!ids.has(p)) ids.set(p, `n${ids.size}`); return ids.get(p); };
  const out = ['graph LR'];
  const seen = new Set();
  const add = (a, b, label) => { const key = `${a}>${b}`; if (!seen.has(key) && seen.size < (opts.max ?? 40)) { seen.add(key); out.push(`  ${id(a)} -->${label ? `|${label}|` : ''} ${id(b)}`); } };
  for (const e of edges) add(e.from, e.to);
  for (const c of callers) if (c.path !== start) add(c.path, start, c.how);
  for (const [p, n] of ids) out.push(`  ${n}["${p.replaceAll('"', "'")}"]`);
  out.push('  style n0 fill:#2457d6,color:#fff');
  return out.join('\n');
}
