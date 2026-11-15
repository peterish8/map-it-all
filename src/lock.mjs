// Lockfile readers: package-lock.json (v1 to v3), yarn.lock (classic) and pnpm-lock.yaml.
//
// All three are normalised into one small model so everything above this file is format-blind:
//
//   lock.direct(relDir, name, range) -> id | null   the installed copy a package at `relDir` gets
//   lock.info(id)                    -> { name, version, bin: string[] }
//   lock.depsOf(id)                  -> id[]        what that copy depends on
//   lock.ids()                       -> id[]        every installed copy
//
// Lockfiles are read straight from disk (the file scan skips them), parsed once per build and only as
// far as each caller needs: the extractor asks for direct versions, the `deps` tool also walks the tree.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const unquote = (s) => s.replace(/^["']|["']$/g, '');
const asArray = (b) => (Array.isArray(b) ? b : typeof b === 'string' ? [b] : b && typeof b === 'object' ? Object.keys(b) : []);

// ---------- package-lock.json ----------

function npmLock(json) {
  if (json.packages) return npmLockV2(json.packages);
  return npmLockV1(json);
}

/** Node resolution over the flat `packages` map: nearest node_modules/<name>, walking outwards. */
function resolveKey(packages, base, name) {
  let b = base.replace(/\/$/, '');
  for (;;) {
    const key = !b ? `node_modules/${name}` : b.endsWith('/node_modules') || b === 'node_modules' ? `${b}/${name}` : `${b}/node_modules/${name}`;
    const entry = packages[key];
    if (entry && !entry.link) return key;
    if (!b) return null;
    const parent = path.posix.dirname(b);
    b = parent === '.' ? '' : parent;
  }
}

function npmLockV2(packages) {
  const ids = Object.keys(packages).filter((k) => k.includes('node_modules/') && !packages[k].link);
  const nameOf = (key) => packages[key].name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return {
    kind: 'npm',
    supportsTraversal: true,
    ids: () => ids,
    info: (id) => ({ name: nameOf(id), version: packages[id].version ?? null, bin: asArray(packages[id].bin) }),
    direct: (relDir, name) => resolveKey(packages, relDir, name),
    depsOf: (id) => {
      const e = packages[id];
      return [...asArray(e.dependencies), ...asArray(e.optionalDependencies)].map((d) => resolveKey(packages, id, d)).filter(Boolean);
    },
  };
}

function npmLockV1(json) {
  // Nested `dependencies`; a copy's id is its path through the tree. `requires` resolve outwards.
  const nodes = new Map();
  const visit = (deps, base) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      const id = base ? `${base}>${name}` : name;
      nodes.set(id, { name, version: entry.version ?? null, bin: [], requires: Object.keys(entry.requires ?? {}), base: id, parent: base });
      visit(entry.dependencies, id);
    }
  };
  visit(json.dependencies, '');
  const find = (from, name) => {
    for (let b = from; ; b = b.slice(0, Math.max(b.lastIndexOf('>'), 0))) {
      const id = b ? `${b}>${name}` : name;
      if (nodes.has(id)) return id;
      if (!b) return null;
    }
  };
  return {
    kind: 'npm',
    supportsTraversal: true,
    ids: () => [...nodes.keys()],
    info: (id) => ({ name: nodes.get(id).name, version: nodes.get(id).version, bin: [] }),
    direct: (_relDir, name) => (nodes.has(name) ? name : null),
    depsOf: (id) => nodes.get(id).requires.map((n) => find(id, n)).filter(Boolean),
  };
}

// ---------- yarn.lock (classic, v1) ----------

function yarnLock(text) {
  const nodes = new Map(); // id (name@version) -> { name, version, deps: [[name, range]] }
  const spec = new Map(); // name@range -> id
  let current = null;
  let inDeps = false;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      current = { specs: raw.replace(/:$/, '').split(',').map((s) => unquote(s.trim())), name: null, version: null, deps: [] };
      current.name = current.specs[0].slice(0, current.specs[0].lastIndexOf('@'));
      inDeps = false;
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (raw.startsWith('    ') && inDeps) {
      const m = line.match(/^("?[^"\s]+"?)\s+"?([^"]+)"?$/);
      if (m) current.deps.push([unquote(m[1]), m[2]]);
    } else if (line.startsWith('version ')) {
      current.version = unquote(line.slice(8).trim());
      const id = `${current.name}@${current.version}`;
      nodes.set(id, current);
      for (const s of current.specs) spec.set(s, id);
      inDeps = false;
    } else inDeps = line === 'dependencies:' || line === 'optionalDependencies:';
  }
  return {
    kind: 'yarn',
    supportsTraversal: true,
    ids: () => [...nodes.keys()],
    info: (id) => ({ name: nodes.get(id).name, version: nodes.get(id).version, bin: [] }),
    direct: (_relDir, name, range) => spec.get(`${name}@${range}`) ?? null,
    depsOf: (id) => nodes.get(id).deps.map(([n, r]) => spec.get(`${n}@${r}`)).filter(Boolean),
  };
}

// ---------- pnpm-lock.yaml ----------

function pnpmLock(text) {
  const importers = new Map(); // dir -> Map(name -> version)
  const nodes = new Map();
  let section = null;
  let imp = null;
  let group = null;
  let dep = null;
  const clean = (v) => unquote(v).replace(/\(.*$/, '');
  const addImporter = (dir) => { if (!importers.has(dir)) importers.set(dir, new Map()); return importers.get(dir); };
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) { section = line.replace(/:.*$/, ''); imp = null; group = null; dep = null; if (/^(dependencies|devDependencies|optionalDependencies)$/.test(section)) imp = addImporter(''); continue; }
    if (section === 'importers') {
      if (indent === 2) { const d = unquote(line.replace(/:$/, '')); imp = addImporter(d === '.' ? '' : d); group = null; }
      else if (indent === 4) group = line.replace(/:$/, '');
      else if (indent === 6 && imp && /^(dependencies|devDependencies|optionalDependencies)$/.test(group ?? '')) {
        const m = line.match(/^("?[^":]+"?)\s*:\s*(.*)$/);
        if (m) { dep = unquote(m[1]); if (m[2]) imp.set(dep, clean(m[2])); }
      } else if (indent === 8 && imp && dep && line.startsWith('version:')) imp.set(dep, clean(line.slice(8).trim()));
    } else if (imp && indent === 2 && /^(dependencies|devDependencies|optionalDependencies)$/.test(section)) {
      const m = line.match(/^("?[^":]+"?)\s*:\s*(.*)$/);
      if (m && m[2]) imp.set(unquote(m[1]), clean(m[2]));
    } else if (section === 'packages' && indent === 2 && line.endsWith(':')) {
      const key = unquote(line.slice(0, -1)).replace(/^\//, '').replace(/\(.*$/, '');
      const m = key.match(/^(.+)@(\d[^@]*)$/) ?? key.match(/^(.+)\/(\d[^/]*)$/);
      if (m) nodes.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
    }
  }
  return {
    kind: 'pnpm',
    supportsTraversal: false,
    ids: () => [...nodes.keys()],
    info: (id) => ({ ...nodes.get(id), bin: [] }),
    direct: (relDir, name) => {
      const v = importers.get(relDir)?.get(name);
      return v && !/^(link|file|workspace):/.test(v) && nodes.has(`${name}@${v}`) ? `${name}@${v}` : null;
    },
    depsOf: () => [],
  };
}

// ---------- discovery ----------

/** Parse the lockfile in `dir` (repo-relative, '' for the root), or null. */
function readLock(root, dir) {
  for (const name of NAMES) {
    const file = path.join(root, dir, name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      const lock = name.endsWith('.json') ? npmLock(JSON.parse(text)) : name === 'yarn.lock' ? yarnLock(text) : pnpmLock(text);
      return { ...lock, dir, file: path.posix.join(dir, name) };
    } catch { return null; }
  }
  return null;
}

/**
 * Finds the lockfile that governs each package.json directory (the nearest one at or above it).
 * Returns `for(dir)` -> { lock, relDir } | null, and `all` (every parsed lockfile).
 */
export function loadLocks(root, pkgDirs) {
  const parsed = new Map();
  const get = (dir) => {
    if (!parsed.has(dir)) parsed.set(dir, readLock(root, dir));
    return parsed.get(dir);
  };
  return {
    for(dir) {
      for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
        const lock = get(d);
        if (lock) return { lock, relDir: dir === d ? '' : d ? dir.slice(d.length + 1) : dir };
        if (!d) return null;
      }
    },
    get all() { for (const d of new Set(pkgDirs.flatMap((p) => ancestors(p)))) get(d); return [...parsed.values()].filter(Boolean); },
  };
}

const ancestors = (dir) => { const out = ['']; let acc = ''; for (const seg of dir.split('/').filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; out.push(acc); } return out; };
