// File-anchored memory and session handoff.
//
// Notes are small JSON files. What makes them different from a flat notes file: every note can be
// anchored to files, and the content hash of each anchor is stored. On recall the hashes are compared
// with the working tree, so an agent is told "this note may be stale: auth.ts changed since it was
// written" instead of trusting a memory the code has moved past.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './context.mjs';
import { PathError, resolveInside } from './paths.mjs';

const KINDS = ['fact', 'decision', 'gotcha', 'todo', 'preference'];
const MAX_BODY = 2000;
const MAX_TITLE = 120;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'note';

/**
 * Hash a file's text with CRLF normalised, so line-ending churn is not "staleness". A path that is not a file
 * inside the project (an escape, or a link that leads out) hashes to null, the same as a missing file.
 */
export function hashFile(root, rel) {
  let full;
  try { full = resolveInside(root, rel); } catch (error) { if (error instanceof PathError) return null; throw error; }
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return createHash('sha1').update(readFileSync(full, 'utf8').replaceAll('\r\n', '\n')).digest('hex').slice(0, 16);
}

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * `versionOf(pkg)` lets a note be pinned to a dependency version (a docs excerpt is only true for the
 * version it was read for). It returns the installed versions, null when the package is gone, or
 * undefined when it cannot tell (no map yet): then the pin is simply not checked.
 */
export function createMemory({ root, dir, versionOf }) {
  const notesDir = path.join(dir, 'notes');
  const handoffFile = path.join(dir, 'handoff.json');

  const pinStates = (pins = []) => pins.flatMap((p) => {
    const now = versionOf?.(p.pkg);
    if (now === undefined) return [];
    if (!now?.length) return [{ path: p.pkg, state: 'missing', detail: `${p.pkg} is no longer a dependency` }];
    return now.includes(p.version) ? [] : [{ path: p.pkg, state: 'changed', detail: `${p.pkg} is now ${now.join(', ')}; this note was written for ${p.version}` }];
  });

  const anchorState = (anchors) => anchors.map((a) => {
    const now = hashFile(root, a.path);
    return { path: a.path, state: now === null ? 'missing' : now === a.hash ? 'ok' : 'changed' };
  });
  const statusOf = (states) => (states.some((s) => s.state === 'missing') ? 'orphaned' : states.some((s) => s.state === 'changed') ? 'stale' : 'fresh');

  const load = () => (existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(notesDir, f))).filter(Boolean) : []);

  function toAnchors(paths = []) {
    return paths.map((raw) => {
      const p = raw.replaceAll('\\', '/').replace(/:\d+(-\d+)?$/, '');
      let why = '';
      try { resolveInside(root, p); } catch (error) { if (!(error instanceof PathError)) throw error; why = ` (${error.reason})`; }
      const hash = why ? null : hashFile(root, p);
      if (hash === null) throw new Error(`anchor "${p}" is not a file in this project${why}. Anchors must be existing files (use a path relative to the repo root).`);
      return { path: p, hash };
    });
  }

  const view = (note) => {
    const states = [...anchorState(note.anchors), ...pinStates(note.pins)];
    return { ...note, status: statusOf(states), anchorStates: states.filter((s) => s.state !== 'ok') };
  };

  return {
    dir,

    remember({ title, body, kind = 'fact', tags = [], anchors = [], pins = [] }) {
      if (!title?.trim() || !body?.trim()) throw new Error('title and body are required');
      if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
      if (body.length > MAX_BODY) throw new Error(`body is ${body.length} chars; keep notes under ${MAX_BODY}. Split it or link a file.`);
      const now = new Date().toISOString();
      const existing = load().find((n) => n.title.toLowerCase() === title.trim().toLowerCase());
      const note = {
        id: existing?.id ?? `${slug(title)}-${createHash('sha1').update(title + now).digest('hex').slice(0, 5)}`,
        title: title.trim().slice(0, MAX_TITLE), body: body.trim(), kind, tags: [...new Set(tags.map((t) => t.toLowerCase()))],
        anchors: toAnchors(anchors), pins: pins.filter((p) => p?.pkg && p?.version).map((p) => ({ pkg: String(p.pkg), version: String(p.version) })), head: git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? null,
        created: existing?.created ?? now, updated: now,
      };
      writeAtomic(path.join(notesDir, `${note.id}.json`), note);
      return { ...view(note), replaced: Boolean(existing) };
    },

    recall({ query = '', kind, tag, limit = 8, includeStale = true } = {}) {
      const tokens = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter((t) => t.length > 1);
      const scored = load().map((n) => {
        let score = 0;
        const title = n.title.toLowerCase();
        const body = n.body.toLowerCase();
        for (const t of tokens) {
          if (title.includes(t)) score += 3;
          if (n.tags.some((x) => x.includes(t))) score += 2;
          if (n.anchors.some((a) => a.path.toLowerCase().includes(t))) score += 3;
          if (body.includes(t)) score += 1;
        }
        return { n, score };
      }).filter(({ n, score }) => (!tokens.length || score > 0) && (!kind || n.kind === kind) && (!tag || n.tags.includes(tag.toLowerCase())));
      scored.sort((a, b) => b.score - a.score || b.n.updated.localeCompare(a.n.updated));
      return scored.map(({ n }) => view(n)).filter((n) => includeStale || n.status === 'fresh').slice(0, limit);
    },

    list: () => load().map(view).sort((a, b) => b.updated.localeCompare(a.updated)),

    forget(id) {
      const file = path.join(notesDir, `${path.basename(id)}.json`);
      if (!existsSync(file)) return false;
      rmSync(file);
      return true;
    },

    /** The agent verified the note is still true: re-hash its anchors. */
    confirm(id) {
      const file = path.join(notesDir, `${path.basename(id)}.json`);
      const note = readJson(file);
      if (!note) return null;
      note.anchors = toAnchors(note.anchors.filter((a) => hashFile(root, a.path) !== null).map((a) => a.path));
      note.pins = (note.pins ?? []).map((p) => { const now = versionOf?.(p.pkg); return now?.length ? { pkg: p.pkg, version: now[0] } : p; });
      note.updated = new Date().toISOString();
      note.head = git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? null;
      writeAtomic(file, note);
      return view(note);
    },

    saveHandoff({ summary, next_steps = [], files = [] }) {
      if (!summary?.trim()) throw new Error('summary is required');
      const handoff = {
        summary: summary.trim().slice(0, 3000),
        nextSteps: next_steps.map((s) => String(s).slice(0, 300)).slice(0, 12),
        files: toAnchors(files),
        branch: git(root, ['branch', '--show-current'])?.trim() ?? '',
        head: git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? null,
        savedAt: new Date().toISOString(),
      };
      writeAtomic(handoffFile, handoff);
      return handoff;
    },

    readHandoff() {
      const h = readJson(handoffFile);
      if (!h) return null;
      const states = anchorState(h.files);
      const headNow = git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? null;
      const behind = h.head && headNow && h.head !== headNow ? Number(git(root, ['rev-list', '--count', `${h.head}..HEAD`])?.trim() ?? 0) : 0;
      return {
        ...h,
        branchNow: git(root, ['branch', '--show-current'])?.trim() ?? '',
        commitsSince: behind,
        changedFiles: states.filter((s) => s.state !== 'ok'),
      };
    },
  };
}

export function formatNote(n) {
  const head = `${n.id}  [${n.kind}] ${n.status.toUpperCase()}${n.tags.length ? `  #${n.tags.join(' #')}` : ''}`;
  const lines = [head, `  ${n.title}`, `  ${n.body.replaceAll('\n', '\n  ')}`];
  if (n.anchors.length) lines.push(`  anchors: ${n.anchors.map((a) => a.path).join(', ')}`);
  for (const s of n.anchorStates) lines.push(`  ! ${s.detail ?? `${s.path} ${s.state === 'missing' ? 'no longer exists' : 'changed since this note was written'}`}: verify before relying on it`);
  return lines.join('\n');
}

export function formatHandoff(h) {
  if (!h) return 'No handoff saved yet.';
  const lines = [
    `Handoff saved ${h.savedAt} on ${h.branch || 'detached'} @ ${h.head}`,
    h.branchNow && h.branch && h.branchNow !== h.branch ? `! branch is now ${h.branchNow}` : null,
    h.commitsSince ? `! ${h.commitsSince} commit(s) landed since` : null,
    '', h.summary,
  ].filter((l) => l !== null);
  if (h.nextSteps.length) lines.push('', 'Next steps:', ...h.nextSteps.map((s, i) => `  ${i + 1}. ${s}`));
  if (h.changedFiles.length) lines.push('', 'Files it mentions that changed since:', ...h.changedFiles.map((s) => `  ${s.path} (${s.state})`));
  return lines.join('\n');
}
