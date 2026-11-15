// Dependencies: one record per declared package, joined to the files that import it.
//
// Offline and deterministic: package.json files, the lockfile and the import scan the build already
// did. Network facts (advisories, deprecations) never enter the build; they live in a separate cache
// and are merged when the `deps` tool runs. See src/deps.mjs.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadLocks } from '../lock.mjs';
import { escapeRe, finalize, lineAt, ref } from '../records.mjs';

const SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'];
const NOT_FROM_REGISTRY = /^(workspace|file|link|portal|patch|git\+|git:|github:|https?:)/;
// Config-ish files where a package can be used without any import (plugins, presets, loaders).
const CONFIG_FILE = /(^|\/)([\w.-]*\.config\.[cm]?[jt]s|\.[\w-]*rc(\.[\w]+)?|(babel|eslint|prettier|postcss|tailwind|jest|vitest|next|metro|app)[\w.-]*\.(json|js|cjs|mjs|ts))$/;

export function packageJsons(ctx) {
  return ctx.files.filter((f) => /(^|\/)package\.json$/.test(f));
}

export function extract(ctx, externals = new Map()) {
  const manifests = [];
  for (const file of packageJsons(ctx)) {
    let json;
    try { json = JSON.parse(ctx.read(file)); } catch { continue; }
    manifests.push({ file, dir: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), json });
  }
  if (!manifests.length) return { records: [] };

  const workspaceNames = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const locks = loadLocks(ctx.root, manifests.map((m) => m.dir));

  // What a script or a config file mentions counts as "used" for the unused-dependency lead.
  const scriptText = manifests.map((m) => Object.values(m.json.scripts ?? {}).join('\n')).join('\n');
  const configText = ctx.files.filter((f) => CONFIG_FILE.test(f) && !ctx.isHistory(f)).slice(0, 80).map((f) => ctx.read(f)).join('\n');
  const mentioned = (name) => scriptText.includes(name) || configText.includes(name);

  const byName = new Map();
  for (const m of manifests) {
    for (const section of SECTIONS) {
      for (const [name, range] of Object.entries(m.json[section] ?? {})) {
        if (workspaceNames.has(name) || NOT_FROM_REGISTRY.test(String(range))) continue;
        if (!byName.has(name)) byName.set(name, { name, declared: [] });
        byName.get(name).declared.push({ file: m.file, dir: m.dir, section, range: String(range) });
      }
    }
  }

  const records = [];
  const seenLocks = new Set();
  for (const { name, declared } of byName.values()) {
    const versions = new Set();
    const bins = new Set();
    for (const d of declared) {
      const found = locks.for(d.dir);
      if (!found) continue;
      seenLocks.add(found.lock.file);
      const id = found.lock.direct(found.relDir, name, d.range);
      if (!id) continue;
      const info = found.lock.info(id);
      if (info.version) versions.add(info.version);
      for (const b of info.bin) bins.add(b);
    }
    const prodDeclared = declared.filter((d) => d.section === 'dependencies' || d.section === 'optionalDependencies');
    const first = [...declared].sort((a, b) => a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file))[0];
    const text = ctx.read(first.file);
    const at = text.search(new RegExp(`"${escapeRe(name)}"\\s*:`));
    const used = externals.get(name) ?? [];
    const hidden = mentioned(name) || [...bins].some(mentioned) || name.startsWith('@types/');
    records.push(finalize({
      id: `dep:${name}`, kind: 'dependency', name, path: first.file, line: at === -1 ? 1 : lineAt(text, at), public: false,
      version: [...versions][0] ?? null, versions: [...versions].sort(), dev: prodDeclared.length === 0,
      declaredIn: declared.map((d) => `${d.file}#${d.section}`).slice(0, 12), bins: [...bins].slice(0, 6),
      // A dependency is only a cleanup lead when it is a production dependency nothing imports,
      // runs in a script or names in a config file. Everything else is expected to have no import.
      entry: prodDeclared.length === 0 || hidden,
      refs: used.map((u) => ref(u.path, u.line, 'import')), flags: [],
    }, ctx));
  }
  // A cheap fingerprint of the lockfiles: the brief uses it to say "the last advisory check is out of date".
  const sig = createHash('sha1');
  for (const f of [...seenLocks].sort()) { try { sig.update(`${f}:${statSync(path.join(ctx.root, f)).size};`); } catch { sig.update(`${f}:gone;`); } }
  return {
    records,
    stats: { depsDirect: records.length, depsLocks: seenLocks.size, depsLockSig: seenLocks.size ? sig.digest('hex').slice(0, 12) : null },
    notes: records.some((r) => !r.version) && !seenLocks.size ? ['no lockfile found next to package.json: dependency versions are unknown, so advisories cannot be checked'] : [],
  };
}
