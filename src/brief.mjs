// Session brief: what an agent needs at the start of a session, in a few hundred tokens, instead of
// re-exploring the repo with dozens of file reads. Generated from the map, git and the memory notes.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './context.mjs';
import { LEAD_FLAGS } from './store.mjs';
import { formatHandoff } from './memory.mjs';

const MAX_CHARS = 6000;

function layout(files) {
  const groups = new Map();
  const bucket = (f, depth) => f.split('/').slice(0, depth).join('/');
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length === 1 ? '(root)' : bucket(f, 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  // A folder that holds most of the repo (apps/, packages/, src/) is split one level deeper.
  for (const [key, list] of [...groups]) {
    if (key !== '(root)' && list.length > files.length * 0.4 && list.some((f) => f.split('/').length > 2)) {
      groups.delete(key);
      for (const f of list) {
        const k = f.split('/').length > 2 ? bucket(f, 2) : key;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
      }
    }
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 9).map(([key, list]) => {
    const ext = {};
    for (const f of list) { const e = path.posix.extname(f).slice(1) || 'other'; ext[e] = (ext[e] ?? 0) + 1; }
    const top = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e).join('/');
    return `${key}  ${list.length} files (${top})`;
  });
}

function packLine(store) {
  const by = (kind) => store.records.filter((r) => r.kind === kind);
  const parts = [];
  const fns = by('convex-function');
  if (fns.length) parts.push(`convex: ${fns.length} functions (${fns.filter((r) => r.public).length} public), ${by('convex-table').length} tables`);
  const routes = by('express-route');
  if (routes.length) parts.push(`express: ${routes.length} routes${routes.some((r) => r.flags.includes('conditional-mount')) ? ` (${routes.filter((r) => r.flags.includes('conditional-mount')).length} conditional)` : ''}`);
  const natives = by('native-module');
  if (natives.length || by('mobile-screen').length) parts.push(`expo/android: ${by('mobile-screen').length} screens, ${natives.length} native modules, ${by('kotlin-class').length} kotlin classes`);
  return parts.length ? parts.join(' · ') : 'no framework packs detected (generic map only)';
}

export function renderBrief({ root, store, memory, files, hidden = [], showGit = true }) {
  const stamp = store.stamp;
  const lines = [`# Session brief: ${stamp.repo}`, ''];

  if (showGit) {
    const branch = git(root, ['branch', '--show-current'])?.trim() || 'detached';
    const head = git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? '?';
    const status = (git(root, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean);
    const commits = (git(root, ['log', '-5', '--pretty=format:%h %s']) ?? '').split('\n').filter(Boolean);
    lines.push(`Git: \`${branch}\` @ ${head}, ${status.length} uncommitted file(s)${status.length ? `: ${status.slice(0, 4).map((l) => l.slice(3).replace(/^(.{14}).*(.{22})$/, '$1…$2')).join(', ')}${status.length > 4 ? `, +${status.length - 4} more` : ''}` : ''}`);
    if (commits.length) lines.push('Recent:', ...commits.map((c) => `  ${c.slice(0, 90)}`));
  } else lines.push('Git: (not shown for the bundled demo)');

  // A partial map must never look complete: say so up front.
  const broken = (stamp.errors ?? []).filter((e) => !e.soft);
  if (broken.length) lines.push('', `!! MAP INCOMPLETE: ${broken.map((e) => `${e.extractor} failed (${e.message.slice(0, 120)})`).join('; ')}. Run \`map-it-all doctor\`. Do not trust absences in this brief.`);

  lines.push('', `Stack: ${packLine(store)}`);
  const product = (files ?? []).filter((f) => !hidden.some((d) => f === d || f.startsWith(`${d.replace(/\/+$/, '')}/`)));
  if (product.length) lines.push('Layout:', ...layout(product).map((l) => `  ${l}`));

  const hubs = [...store.importedBy].map(([f, list]) => [f, new Set(list.filter((i) => !/\.(test|spec)\./.test(i.path)).map((i) => i.path)).size])
    .filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (hubs.length) lines.push('Most-imported files (change with care):', ...hubs.map(([f, n]) => `  ${f}  ×${n}`));

  const publics = {};
  for (const r of store.records) if (r.public) publics[r.kind] = (publics[r.kind] ?? 0) + 1;
  if (Object.keys(publics).length) lines.push(`Public surface (installed clients may still call it: VERIFY before removing): ${Object.entries(publics).map(([k, n]) => `${n} ${k}`).join(', ')}`);

  const leads = {};
  for (const r of store.records) if (!r.history && r.kind !== 'debt' && r.kind !== 'knip' && r.flags.some((f) => LEAD_FLAGS.has(f))) leads[r.kind] = (leads[r.kind] ?? 0) + 1;
  const drift = store.records.filter((r) => r.kind === 'doc-drift');
  if (Object.keys(leads).length) lines.push(`Cleanup leads: ${Object.entries(leads).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  if (drift.length) {
    const worst = [...drift].sort((a, b) => b.deadCount - a.deadCount)[0];
    lines.push(`Docs pointing at missing paths: ${drift.length} doc(s); worst ${worst.path} (${worst.deadCount}). Do not trust those docs' file references.`);
  }

  const handoff = memory.readHandoff();
  if (handoff) lines.push('', '## Last handoff', formatHandoff(handoff));

  const notes = memory.list();
  if (notes.length) {
    const bad = notes.filter((n) => n.status !== 'fresh').length;
    lines.push('', `## Memory: ${notes.length} note(s)${bad ? `, ${bad} possibly stale` : ''}`);
    for (const n of notes.slice(0, 8)) lines.push(`  ${n.status === 'fresh' ? '•' : '!'} [${n.kind}] ${n.title}${n.status === 'fresh' ? '' : ` (${n.status})`}`);
    if (notes.length > 8) lines.push(`  … ${notes.length - 8} more: use memory recall`);
  }

  lines.push('', 'Next: `find`/`file`/`connections` before editing or deleting; `memory` to save what you learn; `handoff` before ending.');
  const text = lines.join('\n');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… brief clipped` : text;
}

export function readFilesList(out) {
  const f = path.join(out, 'files.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).files : [];
}
