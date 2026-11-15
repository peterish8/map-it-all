// Docs drift: current docs (CLAUDE.md, AGENTS.md, README, docs/**) that point at files or folders that
// no longer exist. Stale context misleads an agent worse than no context, so this is checkable fact.
// Fenced code blocks are skipped (examples, hypotheticals); history folders are skipped.
//
// A reference is dead only when no file or folder in the repo ends with that path, so docs that name
// things loosely ("db.ts", "compose/Screens.kt") are not flagged but renames and deletions are.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { finalize } from '../records.mjs';

const SKIP_DOC = /\/_generated\//;
// Generated, ignored or downloaded at build time: absence from a checkout is normal.
const GENERATED = /^(\.map-it-all|\.next|dist|build|node_modules|\.vercel|\.gradle|graft|output|\.expo|coverage)(\/|$)|^\.env/;
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|kt|rs|json|md|yml|yaml|sh|ps1|html|css|toml|gradle|xml|py|go|swift)$/;
const PATH_CHARS = /^[A-Za-z0-9_.\-/]+$/;

function stripFences(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ' '));
}

function suffixes(paths) {
  const set = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) set.add(parts.slice(i).join('/'));
  }
  return set;
}

export function extract(ctx) {
  const dirs = new Set();
  for (const f of ctx.files) for (let d = path.posix.dirname(f); d !== '.' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  const known = suffixes([...ctx.files, ...dirs]);
  const exists = (rel) => known.has(rel.replace(/\/$/, '')) || existsSync(path.join(ctx.root, rel));
  // Docs that describe files in someone else's project (a tool's own README, a template) opt out here.
  const ignored = (ctx.config.driftIgnore ?? []).map((s) => new RegExp(s));

  const records = [];
  for (const doc of ctx.files) {
    if (!doc.endsWith('.md') || ctx.isHistory(doc) || SKIP_DOC.test(doc)) continue;
    const text = stripFences(ctx.read(doc));
    if (!text) continue;
    const dead = [];
    const seen = new Set();
    const consider = (raw, index) => {
      let ref = raw.split('#')[0].split('?')[0];
      if (!ref || /^(https?:|mailto:|~|\/\/)/.test(ref) || ref.startsWith('@') || ref.startsWith('/') || /[*<>{}$|=(),;:\s]/.test(ref) || ref.includes('...')) return;
      if (!PATH_CHARS.test(ref) || !(ref.includes('/') || FILE_EXT.test(ref))) return;
      if (!(FILE_EXT.test(ref) || ref.endsWith('/'))) return;
      ref = ref.replace(/^\.\//, '');
      if (/^\.[A-Za-z0-9]+$/.test(ref)) return; // a bare extension such as `.ts`
      if (ignored.some((re) => re.test(ref))) return;
      if (ref.endsWith('/') && !ref.slice(0, -1).includes('/')) return; // `feat/`, `preview/`: too ambiguous
      const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(doc), ref)), path.posix.normalize(ref)];
      if (candidates.some((c) => GENERATED.test(c) || c.startsWith('..'))) return;
      if (candidates.some(exists) || seen.has(ref)) return;
      seen.add(ref);
      dead.push({ ref, line: text.slice(0, index).split('\n').length });
    };
    for (const m of text.matchAll(/`([^`\n]+)`/g)) consider(m[1], m.index);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) consider(m[1], m.index);
    if (dead.length) {
      records.push(finalize({
        id: `doc-drift:${doc}`, kind: 'doc-drift', name: doc, path: doc, line: dead[0].line, public: false, entry: true,
        deadCount: dead.length, dead: dead.slice(0, 25), refs: [], flags: ['dead-path'],
      }, ctx));
    }
  }
  return { records };
}
