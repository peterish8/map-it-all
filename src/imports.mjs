// Import graph with real alias resolution: tsconfig/jsconfig `paths` (and `extends`), plus workspace
// packages from package.json `workspaces`. Nothing here is specific to one repo layout.

import { builtinModules } from 'node:module';
import path from 'node:path';
import { globToRegExp } from './config.mjs';
import { lineAt } from './records.mjs';

/** JSON with comments and trailing commas (tsconfig style). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function tryFile(ctx, base) {
  const stem = base.replace(/\.(m?js|cjs)$/, '');
  for (const candidate of [base, stem]) {
    for (const e of EXT) if (ctx.has(candidate + e)) return candidate + e;
    for (const e of EXT.slice(1)) if (ctx.has(`${candidate}/index${e}`)) return `${candidate}/index${e}`;
  }
  return null;
}

function loadTsconfig(ctx, file, depth = 0) {
  let json;
  try { json = parseJsonc(ctx.read(file)); } catch { return null; }
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  let paths = {};
  let baseUrl = null;
  if (typeof json.extends === 'string' && json.extends.startsWith('.') && depth < 4) {
    const parent = tryFile(ctx, path.posix.normalize(path.posix.join(dir, json.extends))) ?? tryFile(ctx, path.posix.normalize(path.posix.join(dir, `${json.extends}.json`)));
    const base = parent && loadTsconfig(ctx, parent, depth + 1);
    if (base) { paths = { ...base.paths }; baseUrl = base.baseUrl; }
  }
  const co = json.compilerOptions ?? {};
  if (co.baseUrl) baseUrl = path.posix.normalize(path.posix.join(dir, co.baseUrl));
  if (co.paths) paths = { ...paths, ...Object.fromEntries(Object.entries(co.paths).map(([k, v]) => [k, v.map((t) => ({ t, base: baseUrl ?? dir }))])) };
  return { dir, paths, baseUrl };
}

export function createResolver(ctx) {
  const aliases = []; // { dir, prefix, wildcard, targets: [{ t, base }] }
  for (const f of ctx.files) {
    if (!/(^|\/)(tsconfig[^/]*|jsconfig)\.json$/.test(f)) continue;
    const cfg = loadTsconfig(ctx, f);
    if (!cfg) continue;
    for (const [pattern, targets] of Object.entries(cfg.paths)) {
      const wildcard = pattern.endsWith('/*');
      aliases.push({ dir: cfg.dir, prefix: wildcard ? pattern.slice(0, -1) : pattern, wildcard, targets: targets.map((x) => (typeof x === 'string' ? { t: x, base: cfg.dir } : x)) });
    }
  }
  aliases.sort((a, b) => b.dir.length - a.dir.length);

  // Workspace packages: name -> directory.
  const workspaces = new Map();
  const rootPkg = (() => { try { return JSON.parse(ctx.read('package.json')); } catch { return {}; } })();
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
  const res = patterns.map((p) => globToRegExp(`${p.replace(/\/$/, '')}`));
  for (const f of ctx.files) {
    if (!/(^|\/)package\.json$/.test(f) || f === 'package.json') continue;
    const dir = path.posix.dirname(f);
    if (patterns.length && !res.some((re) => re.test(dir))) continue;
    try { const name = JSON.parse(ctx.read(f)).name; if (name) workspaces.set(name, dir); } catch { /* skip */ }
  }

  function packageEntry(dir) {
    let pkg = {};
    try { pkg = JSON.parse(ctx.read(`${dir}/package.json`)); } catch { /* defaults */ }
    const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
    const exp = typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? dot?.types;
    for (const rel of [pkg.source, exp, pkg.types, pkg.typings, pkg.module, pkg.main, 'src/index', 'index']) {
      if (typeof rel !== 'string') continue;
      const hit = tryFile(ctx, path.posix.normalize(path.posix.join(dir, rel.replace(/\.d\.ts$/, '').replace(/^\.\//, ''))));
      if (hit) return hit;
    }
    return null;
  }

  /** Resolve an import specifier written in file `from` to a repo-relative file, or null (external). */
  function resolve(spec, from) {
    if (spec.startsWith('.')) return tryFile(ctx, path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
    for (const a of aliases) {
      if (a.dir && !from.startsWith(`${a.dir}/`)) continue;
      const hit = a.wildcard ? spec.startsWith(a.prefix) && spec.slice(a.prefix.length) : spec === a.prefix && '';
      if (hit === false || hit === undefined || hit === null) continue;
      for (const { t, base } of a.targets) {
        const target = path.posix.normalize(path.posix.join(base, t.replace(/\*$/, '') + hit));
        const found = tryFile(ctx, target);
        if (found) return found;
      }
    }
    for (const [name, dir] of workspaces) {
      if (spec === name) return packageEntry(dir);
      if (spec.startsWith(`${name}/`)) {
        const rest = spec.slice(name.length + 1);
        return tryFile(ctx, `${dir}/${rest}`) ?? tryFile(ctx, `${dir}/src/${rest}`);
      }
    }
    return null;
  }

  return { resolve, aliasCount: aliases.length, workspaceCount: workspaces.size, workspaceDirs: [...workspaces.values()] };
}

const IMPORT_RES = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const BUILTINS = new Set(builtinModules);

/** `@scope/name/deep/path` -> `@scope/name`, `name/sub` -> `name`; null for relative, node: and builtin specifiers. */
export function packageName(spec) {
  if (!spec || spec[0] === '.' || spec[0] === '/' || spec.startsWith('node:') || /^[a-z]+:/i.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec[0] === '@' ? parts.slice(0, 2).join('/') : parts[0];
  return !name || (spec[0] !== '@' && BUILTINS.has(name)) || (spec[0] === '@' && parts.length < 2) ? null : name;
}

/** target file -> [{ path, line, names }] for every resolvable internal import. */
export function buildImportGraph(ctx, resolver = createResolver(ctx)) {
  return scanImports(ctx, resolver).reverse;
}

/**
 * One pass over every code file. `reverse` is the internal import graph; `externals` maps a package
 * name to the places that import it (`[{ path, line }]`), found in the same pass at no extra cost.
 */
export function scanImports(ctx, resolver = createResolver(ctx)) {
  const reverse = new Map();
  const externals = new Map();
  for (const from of ctx.codeFiles) {
    const text = ctx.read(from);
    if (!text) continue;
    for (const re of IMPORT_RES) {
      for (const m of text.matchAll(re)) {
        const target = resolver.resolve(m[1], from);
        if (!target) {
          const pkg = packageName(m[1]);
          if (pkg) {
            if (!externals.has(pkg)) externals.set(pkg, []);
            externals.get(pkg).push({ path: from, line: lineAt(text, m.index) });
          }
          continue;
        }
        if (target === from) continue;
        const names = (m[0].match(/\{([^}]*)\}/)?.[1] ?? '').split(',')
          .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
          .filter(Boolean);
        if (!reverse.has(target)) reverse.set(target, []);
        reverse.get(target).push({ path: from, line: lineAt(text, m.index), names });
      }
    }
  }
  return { reverse, externals };
}

/** Local binding name -> import specifier for one file (default, named, namespace, require). */
export function importBindings(text) {
  const bindings = new Map();
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)?\s*,?\s*(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))?\s*from\s+['"]([^'"]+)['"]/g)) {
    const [, def, named, ns, spec] = m;
    if (def) bindings.set(def, spec);
    if (ns) bindings.set(ns, spec);
    if (named) for (const part of named.split(',')) { const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop(); if (n) bindings.set(n, spec); }
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const [, named, def, spec] = m;
    if (def) bindings.set(def, spec);
    if (named) for (const part of named.split(',')) { const n = part.trim().split(/\s*:\s*/).pop(); if (n) bindings.set(n, spec); }
  }
  return bindings;
}
