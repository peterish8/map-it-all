// Build the map: run the detected packs and generic extractors, write .map-it-all/, and provide the
// freshness check, session snapshot and diff.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from './config.mjs';
import { createContext, fingerprint } from './context.mjs';
import { createResolver, scanImports } from './imports.mjs';
import { LEAD_FLAGS, loadStore } from './store.mjs';
import { renderView } from './view.mjs';

export const GENERATOR_VERSION = 4;

const PACKS = ['convex', 'express', 'expo'];
const EXTRACTORS = ['tooling', 'docs', 'drift', 'debt'];

export const outDirFor = (root, config = loadConfig(root)) => path.resolve(root, config.out);

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function jsonRecords(header, records) {
  const head = Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
  return `{${head},"records":[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

/** Build the map. `write: false` keeps everything in memory (used by `check`). */
export async function buildMap({ root, out, withKnip = false, write = true, log = () => {} } = {}) {
  const t0 = performance.now();
  root = path.resolve(root);
  const config = loadConfig(root);
  out = out ? path.resolve(out) : outDirFor(root, config);
  const ctx = createContext(root, config);
  const resolver = createResolver(ctx);
  const { reverse: graph, externals } = scanImports(ctx, resolver);

  const results = {};
  const errors = [];
  const timings = {};
  const stats = {};
  const detected = {};
  const wanted = config.packs === 'auto' ? PACKS : config.packs;

  const run = async (name, fn) => {
    const t = performance.now();
    try {
      const r = await fn();
      results[name] = r;
      if (r.stats) Object.assign(stats, r.stats);
      for (const n of r.notes ?? []) errors.push({ extractor: name, message: n, soft: true });
    } catch (error) {
      errors.push({ extractor: name, message: String(error.message ?? error) });
      results[name] = { records: [] };
    }
    timings[name] = Math.round(performance.now() - t);
    log(`  ${name.padEnd(8)} ${String(results[name].records.length).padStart(5)} records  ${timings[name]} ms`);
  };

  for (const name of wanted) {
    if (!PACKS.includes(name)) { errors.push({ extractor: name, message: `unknown pack "${name}"`, soft: true }); continue; }
    const pack = await import(`./packs/${name}.mjs`);
    const opts = pack.detect(ctx);
    if (!opts) continue;
    detected[name] = opts;
    await run(name, () => pack.extract(ctx, opts, resolver));
  }
  for (const name of EXTRACTORS) await run(name, async () => (await import(`./extractors/${name}.mjs`)).extract(ctx));
  await run('deps', async () => (await import('./extractors/deps.mjs')).extract(ctx, externals));
  if (withKnip) await run('knip', async () => (await import('./extractors/knip.mjs')).extract(ctx, graph, resolver));

  const index = {};
  for (const [target, list] of [...graph].sort(([a], [b]) => a.localeCompare(b))) index[target] = list.map((i) => `${i.path}:${i.line}`);
  results.imports = { records: [], extra: { file: 'imports.json', kind: 'imports', index } };

  const stamp = {
    ...fingerprint(root),
    generatedAt: new Date().toISOString(),
    generator: GENERATOR_VERSION,
    repo: path.basename(root),
    root: root.replaceAll('\\', '/'),
    files: ctx.files.length,
    ms: Math.round(performance.now() - t0),
    packs: detected,
    resolver: { aliases: resolver.aliasCount, workspaces: resolver.workspaceCount },
    timings,
    counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.records.length])),
    stats,
    checks: parity(ctx, detected, stats),
    errors,
  };

  if (write) {
    mkdirSync(out, { recursive: true });
    // Each file is replaced atomically (write temp, rename), so a reader never sees half a file. The
    // stamp goes last: it is the marker readers compare before and after loading.
    for (const [name, r] of Object.entries(results)) {
      if (r.extra) {
        atomicWrite(path.join(out, r.extra.file), `${JSON.stringify({ kind: r.extra.kind, head: stamp.head, count: Object.keys(r.extra.index).length, index: r.extra.index })}\n`);
      } else {
        atomicWrite(path.join(out, `${name}.json`), jsonRecords({ extractor: name, head: stamp.head, count: r.records.length }, r.records));
      }
    }
    atomicWrite(path.join(out, 'files.json'), `${JSON.stringify({ files: ctx.files })}\n`);
    atomicWrite(path.join(out, 'INDEX.md'), renderIndex(stamp, results));
    atomicWrite(path.join(out, 'graph.html'), renderView({ root, stamp, results, files: ctx.files, hidden: config.historyDirs }));
    atomicWrite(path.join(out, 'stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  }
  ctx.dispose();
  return { stamp, results, files: ctx.files, root, out };
}

/** Cross-check ast-grep against plain regexes so a rule that stops matching is loud. */
function parity(ctx, detected, stats) {
  const checks = [];
  if (detected.convex) {
    const dir = detected.convex.dir;
    const re = /^export const \w+ = (?:query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\(/;
    let expected = 0;
    for (const f of ctx.codeFiles) {
      if (!f.startsWith(`${dir}/`) || !/^[^/]+\.(ts|js)$/.test(f.slice(dir.length + 1)) || ctx.isTest(f)) continue;
      for (const line of ctx.read(f).split('\n')) if (re.test(line)) expected++;
    }
    checks.push({ name: 'convex functions', found: stats.convexFound ?? 0, expected });
  }
  if (detected.express) checks.push({ name: 'express routes', found: stats.routeCount ?? 0, expected: stats.routeRegex ?? 0 });
  return checks;
}

// ---------- INDEX.md ----------

function renderIndex(stamp, results) {
  const all = Object.entries(results).flatMap(([file, r]) => r.records.map((x) => ({ ...x, file })));
  const lines = [
    `# Code map: ${stamp.repo} (generated, do not edit)`,
    '',
    `HEAD \`${stamp.head.slice(0, 8)}\` on \`${stamp.branch || 'detached'}\` · tree \`${stamp.dirtyHash}\` · ${stamp.generatedAt} · ${stamp.files} files · ${stamp.ms} ms`,
    `Packs: ${Object.keys(stamp.packs).join(', ') || 'none detected (generic checks only)'} · import aliases ${stamp.resolver.aliases} · workspaces ${stamp.resolver.workspaces}`,
    '',
    'Reflects the working tree, uncommitted edits included. Zero refs is a **candidate**, never proof. `public: true` means installed',
    'clients or external callers may still use it, so absence here means VERIFY, not REMOVE.',
    '',
    '**Look up:** MCP tools `find`, `file`, `connections` (or `map-it-all query <text>`) · **Rebuild:** `map-it-all build` · **Session diff:** `map-it-all diff`',
    '',
    '| file | records | flagged | top flags |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const [file, r] of Object.entries(results)) {
    if (file === 'imports') continue;
    const flagged = r.records.filter((x) => x.flags.length);
    const byFlag = {};
    for (const x of flagged) for (const f of x.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
    const top = Object.entries(byFlag).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f, n]) => `${f} ${n}`).join(', ');
    lines.push(`| ${file}.json | ${r.records.length} | ${flagged.length} | ${top} |`);
  }
  lines.push('', '## Leads', '');
  for (const [file, r] of Object.entries(results)) {
    const leads = r.records.filter((x) => x.flags.some((f) => LEAD_FLAGS.has(f)) && !x.history);
    if (!leads.length || file === 'docs' || file === 'debt') continue;
    lines.push(`### ${file}.json (${leads.length})`);
    for (const x of leads.slice(0, 8)) lines.push(`- \`${x.id}\` ${x.path}:${x.line} [${x.flags.join(', ')}]${x.public ? ' public' : ''}`);
    if (leads.length > 8) lines.push(`- … +${leads.length - 8} more`);
    lines.push('');
  }
  const docs = all.filter((x) => x.kind === 'doc');
  lines.push(`### docs: ${docs.filter((x) => !x.history && x.flags.includes('no-refs')).length} current docs with no inbound link`, '');
  const debt = all.filter((x) => x.kind === 'debt').sort((a, b) => b.total - a.total);
  lines.push(`### debt: ${debt.length} files with markers, ${debt.reduce((n, x) => n + x.total, 0)} markers; worst: ${debt.slice(0, 3).map((x) => `${x.path} (${x.total})`).join(', ') || 'none'}`, '');
  lines.push(
    '## Blind spots',
    '',
    '- Strings built at runtime, reflection, and anything reachable only from outside this repo.',
    '- Import resolution follows tsconfig `paths` and workspace packages; unusual bundler aliases are not seen.',
    '- Name matching (docs, scripts, Kotlin classes) can treat a generic basename as referenced.',
    '- Knip candidates exist only after `map-it-all build --with-knip`.',
    '',
  );
  if (stamp.errors.length) lines.push('## Generator problems', '', ...stamp.errors.map((e) => `- ${e.extractor}: ${e.message}`), '');
  return `${lines.join('\n')}\n`;
}

// ---------- freshness, snapshot, diff, check ----------

export function isFresh(root, out) {
  const p = path.join(out, 'stamp.json');
  if (!existsSync(p)) return false;
  const s = JSON.parse(readFileSync(p, 'utf8'));
  const f = fingerprint(root);
  return s.generator === GENERATOR_VERSION && s.head === f.head && s.dirtyHash === f.dirtyHash;
}

export function snapshot(out) {
  const baseDir = path.join(out, 'baseline');
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true });
  for (const f of readdirSync(out).filter((n) => n.endsWith('.json'))) copyFileSync(path.join(out, f), path.join(baseDir, f));
}

function recordsIn(dir) {
  const store = existsSync(path.join(dir, 'stamp.json')) ? loadStore(dir) : null;
  return store ? store.records : [];
}

/** What changed since the session-start snapshot: records that lost their last production reference. */
export function diff(out) {
  const baseDir = path.join(out, 'baseline');
  if (!existsSync(baseDir)) return 'No baseline yet. It is saved at session start (`map-it-all session-start`) or with `map-it-all snapshot`.';
  const base = new Map(recordsIn(baseDir).map((r) => [r.id, r]));
  const cur = new Map(recordsIn(out).map((r) => [r.id, r]));
  const orphaned = [];
  const removed = [];
  const added = [];
  for (const [id, b] of base) {
    const c = cur.get(id);
    if (!c) { if (b.kind !== 'doc' && b.kind !== 'debt' && b.kind !== 'doc-drift') removed.push(b); continue; }
    if (b.prodRefCount > 0 && c.prodRefCount === 0 && !c.entry) orphaned.push({ b, c });
  }
  for (const [id, c] of cur) {
    if (!base.has(id) && c.flags.some((f) => ['no-refs', 'test-only', 'unmounted'].includes(f)) && c.kind !== 'doc') added.push(c);
  }
  const fmt = (r) => `- \`${r.id}\` ${r.path}:${r.line}`;
  const lines = ['# Map diff since session start', ''];
  lines.push(`## Newly orphaned (had production refs, now none): ${orphaned.length}`, ...orphaned.map(({ b, c }) => `${fmt(c)} (was ${b.prodRefCount} refs) [${c.flags.join(', ')}]${c.public ? ' public: VERIFY, not REMOVE' : ''}`), '');
  lines.push(`## Removed records: ${removed.length}`, ...removed.slice(0, 40).map(fmt), '');
  lines.push(`## New surface nothing uses: ${added.length}`, ...added.slice(0, 40).map((r) => `${fmt(r)} [${r.flags.join(', ')}]`), '');
  return lines.join('\n');
}

/** Problems that mean the map itself is untrustworthy (used by `check` and CI). */
export function check(stamp) {
  const problems = stamp.errors.filter((e) => !e.soft).map((e) => `extractor ${e.extractor} failed: ${e.message}`);
  for (const c of stamp.checks) {
    if (c.found !== c.expected) problems.push(`${c.name}: ast-grep found ${c.found}, a plain regex found ${c.expected}. Update the pack's rules.`);
  }
  return problems;
}
