// Express pack: every route with its full mount path, whether the mount is conditional, who calls the
// URL, and whether any current doc mentions it. Installed mobile builds and external clients call
// production, so "no callers here" is a lead for VERIFY, never proof.
//
// Supported: app.get/post/...; routers declared in the same file or imported (default export, named
// factory call, require); nested router.use('/x', sub). Not yet: dynamic mount paths, Router
// options such as mergeParams, several routers sharing one file with different mounts.

import { importBindings } from '../imports.mjs';
import { finalize, ref } from '../records.mjs';
import { baseId, rulesFor, splitArgs, unquote } from './util.mjs';

export const name = 'express';

const RECEIVER = '^(app|router|r|route|routes|api|v\\d+|\\w*[Rr]outer)$';
const VERBS = '^(get|post|put|patch|delete|all)$';
const USES_EXPRESS = /from\s+['"]express['"]|require\(\s*['"]express['"]\s*\)|\bRouter\s*\(/;

const param = (p) => p.replace(/\$\{[^}]*\}/g, ':p').replace(/:[A-Za-z_]\w*/g, ':p').replace(/\/+$/, '') || '/';
const segments = (p) => param(p).split('/').filter(Boolean);
const joinPath = (a, b) => `${a}${b === '/' ? '' : b}` || '/';

function matches(routeSegs, urlSegs, prefix) {
  if (prefix) {
    if (urlSegs.length > routeSegs.length || routeSegs.length - urlSegs.length > 1) return false;
  } else if (urlSegs.length !== routeSegs.length) return false;
  return urlSegs.length > 0 && urlSegs.every((s, i) => s === routeSegs[i] || s === ':p' || routeSegs[i] === ':p');
}

export function detect(ctx) {
  const configured = ctx.config.express.appFiles;
  if (configured?.length) return { appFiles: configured.filter((f) => ctx.has(f)) };
  const appFiles = ctx.codeFiles.filter((f) => {
    if (ctx.isTest(f)) return false;
    const text = ctx.read(f);
    return /\bexpress\s*\(\s*\)/.test(text) && /from\s+['"]express['"]|require\(\s*['"]express['"]\s*\)/.test(text);
  });
  return appFiles.length ? { appFiles } : null;
}

export function extract(ctx, opts, resolver) {
  const { appFiles } = opts;
  const appSet = new Set(appFiles);
  const routeFiles = ctx.codeFiles.filter((f) => !ctx.isTest(f) && (appSet.has(f) || USES_EXPRESS.test(ctx.read(f))));
  const routeSet = new Set(routeFiles);

  const yaml = [
    rulesFor(routeFiles, ({ language, suffix, filesLine }) => `id: express-route${suffix}
language: ${language}
severity: hint
${filesLine}rule:
  pattern: $R.$M($P, $$$A)
constraints:
  M:
    regex: ${JSON.stringify(VERBS)}
  R:
    regex: ${JSON.stringify(RECEIVER)}
  P:
    regex: ${JSON.stringify('^[`\'"]/')}
`),
    rulesFor(routeFiles, ({ language, suffix, filesLine }) => `id: express-mount${suffix}
language: ${language}
severity: hint
${filesLine}rule:
  pattern: $R.use($$$A)
constraints:
  R:
    regex: ${JSON.stringify(RECEIVER)}
`),
    rulesFor(routeFiles, ({ language, suffix, filesLine }) => `id: express-mount-if${suffix}
language: ${language}
severity: hint
${filesLine}rule:
  pattern: $R.use($$$A)
  inside:
    kind: if_statement
    stopBy: end
constraints:
  R:
    regex: ${JSON.stringify(RECEIVER)}
`),
  ].join('\n---\n');

  const hits = ctx.sg(yaml, { text: true }).map((h) => ({ ...h, ruleId: baseId(h.ruleId) }));
  const routes = hits.filter((h) => h.ruleId === 'express-route');
  const conditional = new Set(hits.filter((h) => h.ruleId === 'express-mount-if').map((h) => `${h.file}:${h.line}`));

  // Named exports that look like routers, for factories imported through a barrel or not imported at all.
  const exportedBy = new Map();
  for (const hit of ctx.grep(/export\s+(?:default\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=/, (f) => routeSet.has(f))) {
    exportedBy.set(hit.groups[0] ?? hit.groups[1], hit.path);
  }

  // ---- mounts: child file -> [{ parent, prefix, line, condition }]; same-file routers keyed "file#name"
  const mounts = new Map();
  const selfMounts = new Map();
  const add = (map, key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const h of hits.filter((x) => x.ruleId === 'express-mount')) {
    const inner = h.text.replace(/^[\w$.]+\.use\(/, '').replace(/\)\s*;?\s*$/, '');
    let args = splitArgs(inner);
    let prefix = '';
    if (args.length && /^[`'"]/.test(args[0])) { prefix = unquote(args.shift()); }
    const bindings = importBindings(ctx.read(h.file));
    const lines = ctx.read(h.file).split('\n');
    const near = lines.slice(Math.max(0, h.line - 3), h.line).join(' ');
    const condition = conditional.has(`${h.file}:${h.line}`) ? near.match(/\bif\s*\(([^)]*\)?)\)/)?.[1]?.trim() ?? 'conditional' : null;
    for (const arg of [...args].reverse()) {
      let target = null;
      let m = arg.match(/^require\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m) target = resolver.resolve(m[1], h.file);
      else if ((m = arg.match(/^([A-Za-z_$][\w$]*)\s*\(/) ?? arg.match(/^([A-Za-z_$][\w$]*)(?:\.\w+)?$/))) {
        const ident = m[1];
        const spec = bindings.get(ident);
        if (spec) target = resolver.resolve(spec, h.file);
        if (!target && exportedBy.has(ident)) target = exportedBy.get(ident);
        if (!target && new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*(?:express\\.)?Router\\s*\\(`).test(ctx.read(h.file))) {
          add(selfMounts, `${h.file}#${ident}`, { parent: h.file, prefix, line: h.line, condition });
          break;
        }
      }
      if (target && routeSet.has(target) && target !== h.file) { add(mounts, target, { parent: h.file, prefix, line: h.line, condition }); break; }
    }
  }

  // Full prefixes for a file: every way it can be reached from an app file.
  const fullPrefixes = (file, seen = new Set()) => {
    if (seen.has(file)) return [];
    const next = new Set([...seen, file]);
    const out = [];
    if (appSet.has(file)) out.push({ prefix: '', via: null });
    for (const m of mounts.get(file) ?? []) {
      for (const p of fullPrefixes(m.parent, next)) out.push({ prefix: joinPath(p.prefix, m.prefix || '/'), via: m });
    }
    return out;
  };

  // ---- callers: string and template literals that are a route path
  const urls = [];
  for (const f of ctx.codeFiles) {
    if (routeSet.has(f)) continue;
    const text = ctx.read(f);
    if (!text.includes('/')) continue;
    for (const m of text.matchAll(/[`'"}](\/(?:\$\{[^}]*\}|[A-Za-z0-9_\-./:[\]])+)/g)) {
      const literal = m[1];
      urls.push({ path: f, index: m.index, segs: segments(literal.split('?')[0]), prefix: literal.endsWith('/') });
    }
  }
  const documented = new Set();
  for (const hit of ctx.grep(/\/[A-Za-z0-9_\-./:{}[\]]{2,}/, (f) => f.endsWith('.md') && !ctx.isHistory(f))) documented.add(segments(hit.match).join('/'));

  const records = [];
  let unmounted = 0;
  for (const r of routes) {
    const method = r.vars.M.toUpperCase();
    const routePath = unquote(r.vars.P);
    const self = selfMounts.get(`${r.file}#${r.vars.R}`);
    let mountList;
    if (self) mountList = self.flatMap((s) => fullPrefixes(s.parent).map((p) => ({ prefix: joinPath(p.prefix, s.prefix || '/'), line: s.line, condition: s.condition })));
    else mountList = fullPrefixes(r.file).map((p) => ({ prefix: p.prefix, line: p.via?.line ?? 0, condition: p.via?.condition ?? null }));
    if (!mountList.length) { mountList = [null]; unmounted++; }
    for (const mount of mountList) {
      const full = joinPath(mount?.prefix ?? '', routePath);
      const segs = segments(full);
      const rec = {
        id: `express:${method} ${param(full)}`, kind: 'express-route', name: `${method} ${full}`, path: r.file, line: r.line,
        public: true, method, mount: mount ? { prefix: mount.prefix, line: mount.line, condition: mount.condition } : null,
        refs: [], flags: [],
      };
      if (!mount) rec.flags.push('unmounted');
      if (mount?.condition) rec.flags.push('conditional-mount');
      if (!documented.has(segs.join('/'))) rec.flags.push('undocumented');
      for (const u of urls) {
        if (matches(segs, u.segs, u.prefix)) rec.refs.push(ref(u.path, ctx.read(u.path).slice(0, u.index).split('\n').length, u.prefix ? 'prefix' : 'url'));
      }
      records.push(finalize(rec, ctx));
    }
  }

  const regexCount = ctx.grep(new RegExp(`\\b(?:app|router|r|route|routes|api|v\\d+|\\w*[Rr]outer)\\.(?:get|post|put|patch|delete|all)\\(\\s*[\`'"]/`), (f) => routeSet.has(f)).length;
  return { records, stats: { routeCount: routes.length, routeRegex: regexCount, unmounted } };
}
