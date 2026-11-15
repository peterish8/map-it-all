// Convex pack: functions (with every caller form), tables (with db reads and writes), HTTP routes.
// Convex clients (phones, other apps) call functions by name, so a public function with no caller in
// this repo is a lead, not proof.

import path from 'node:path';
import { finalize, ref } from '../records.mjs';
import { baseId, rulesFor } from './util.mjs';

export const name = 'convex';

const FN_STRING = /['"`]([A-Za-z0-9_]+):([A-Za-z0-9_]+)['"`]/g;
const DB_OP = /\bdb\.(query|get|insert|patch|replace|delete|normalizeId)\(\s*['"](\w+)['"]/g;
const WRITE_OPS = new Set(['insert', 'patch', 'replace', 'delete']);

export function detect(ctx) {
  const dir = (ctx.config.convex.dir ?? 'convex').replace(/\/+$/, '');
  const has = ctx.files.some((f) => f.startsWith(`${dir}/`) && /^[^/]+\.(ts|js)$/.test(f.slice(dir.length + 1)))
    && (ctx.has(`${dir}/schema.ts`) || ctx.files.some((f) => f.startsWith(`${dir}/_generated/`)));
  return has ? { dir } : null;
}

export function extract(ctx, opts) {
  const { dir } = opts;
  const defFiles = ctx.files.filter((f) => f.startsWith(`${dir}/`) && /^[^/]+\.(ts|js)$/.test(f.slice(dir.length + 1)) && !ctx.isTest(f));
  const yaml = [
    rulesFor(defFiles, ({ language, suffix, filesLine }) => `id: convex-def${suffix}
language: ${language}
severity: hint
${filesLine}rule:
  pattern: export const $NAME = $KIND($$$A)
constraints:
  KIND:
    regex: ^(query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)$
`),
    rulesFor(null, ({ language, suffix, ignoresWith }) => `id: convex-ref${suffix}
language: ${language}
severity: hint
${ignoresWith([`${dir}/_generated/**`, ...ctx.config.historyDirs.map((d) => `${d.replace(/\/+$/, '')}/**`)])}rule:
  pattern: $ROOT.$MOD.$FN
constraints:
  ROOT:
    regex: ^(api|internal|anyApi)$
`),
  ].filter(Boolean).join('\n---\n');

  const hits = ctx.sg(yaml).map((h) => ({ ...h, ruleId: baseId(h.ruleId) }));
  const defs = new Map();
  const records = [];

  for (const h of hits.filter((x) => x.ruleId === 'convex-def')) {
    const mod = path.posix.basename(h.file).replace(/\.(ts|js)$/, '');
    const key = `${mod}.${h.vars.NAME}`;
    const kind = h.vars.KIND;
    const rec = {
      id: `convex:${key}`, kind: 'convex-function', name: key, path: h.file, line: h.line,
      fn: kind, public: !kind.startsWith('internal') && kind !== 'httpAction', refs: [], flags: [],
    };
    defs.set(key, rec);
    records.push(rec);
  }

  for (const h of hits.filter((x) => x.ruleId === 'convex-ref')) {
    const rec = defs.get(`${h.vars.MOD}.${h.vars.FN}`);
    if (!rec) continue;
    rec.refs.push(ref(h.file, h.line, h.file === `${dir}/crons.ts` ? 'cron' : h.vars.ROOT));
  }

  // 'module:fn' strings: API gateways, makeFunctionReference, scripts.
  for (const hit of ctx.grep(FN_STRING, (f) => !f.startsWith(`${dir}/_generated/`) && !f.endsWith('.md'))) {
    const rec = defs.get(`${hit.groups[0]}.${hit.groups[1]}`);
    if (rec) rec.refs.push(ref(hit.path, hit.line, 'string'));
  }

  // Wrappers such as makeFunctionReference(`luvLink:${name}`) called as query('createRoom'):
  // the module comes from the template, the function from a string literal in the same file.
  const codeSet = new Set(ctx.codeFiles);
  for (const hit of ctx.grep(/`([A-Za-z0-9_]+):\$\{\w+\}`/, (f) => codeSet.has(f) && !f.startsWith(`${dir}/`))) {
    const text = ctx.read(hit.path);
    for (const rec of defs.values()) {
      const [mod, fn] = rec.name.split('.');
      if (mod !== hit.groups[0]) continue;
      for (const m of text.matchAll(new RegExp(`['"\`]${fn}['"\`]`, 'g'))) {
        const line = text.slice(0, m.index).split('\n').length;
        if (line !== hit.line) rec.refs.push(ref(hit.path, line, 'wrapper'));
      }
    }
  }

  // Runbooks and docs that name a function (manual operations such as takedowns) are consumers too.
  for (const hit of ctx.grep(/(?<![A-Za-z0-9_])(?=([A-Za-z0-9_]+)[:.]([A-Za-z0-9_]+))/, (f) => f.endsWith('.md') && !ctx.isHistory(f))) {
    const rec = defs.get(`${hit.groups[0]}.${hit.groups[1]}`);
    if (rec) rec.refs.push(ref(hit.path, hit.line, 'doc'));
  }

  // httpAction handlers are wired in the http router by identifier, not by api.x.y.
  const httpFile = `${dir}/http.ts`;
  for (const rec of defs.values()) {
    if (rec.fn !== 'httpAction') continue;
    const fn = rec.name.split('.')[1];
    for (const u of ctx.grep(new RegExp(`\\b${fn}\\b`), (f) => f === httpFile)) {
      if (!(u.path === rec.path && u.line === rec.line)) rec.refs.push(ref(u.path, u.line, 'http'));
    }
  }

  records.push(...tables(ctx, dir), ...httpRoutes(ctx, httpFile));
  return {
    records: records.map((r) => finalize(r, ctx)),
    stats: { convexFound: records.filter((r) => r.kind === 'convex-function').length },
  };
}

function tables(ctx, dir) {
  const schemaFile = `${dir}/schema.ts`;
  const schema = ctx.has(schemaFile) ? ctx.read(schemaFile) : '';
  const out = [];
  const byName = new Map();
  for (const m of schema.matchAll(/^\s+(\w+):\s*defineTable\(/gm)) {
    const rec = {
      id: `convex-table:${m[1]}`, kind: 'convex-table', name: m[1], path: schemaFile,
      line: schema.slice(0, m.index).split('\n').length, public: false, refs: [], flags: [],
    };
    byName.set(m[1], rec);
    out.push(rec);
  }
  for (const hit of ctx.grep(DB_OP, (f) => f.startsWith(`${dir}/`) && !f.startsWith(`${dir}/_generated/`))) {
    const rec = byName.get(hit.groups[1]);
    if (rec) rec.refs.push(ref(hit.path, hit.line, WRITE_OPS.has(hit.groups[0]) ? 'write' : 'read'));
  }
  for (const rec of out) if (!rec.refs.some((r) => r.how === 'write')) rec.flags.push('never-written-here');
  return out;
}

function httpRoutes(ctx, httpFile) {
  if (!ctx.has(httpFile)) return [];
  const text = ctx.read(httpFile);
  const out = [];
  for (const m of text.matchAll(/\bpath(Prefix)?:\s*['"]([^'"]+)['"]/g)) {
    out.push({
      id: `convex-http:${m[2]}`, kind: 'convex-http', name: m[2], path: httpFile,
      line: text.slice(0, m.index).split('\n').length, public: true, entry: true, refs: [], flags: [],
    });
  }
  return out;
}
