// Realtime mode: keep the map fresh while an agent edits, at almost no cost.
//
//   * No daemon, no file watcher. An edit hook (Claude Code PostToolUse) calls `touch` only when the
//     agent edits a file, so nothing runs while idle.
//   * `touch` returns in about 100 ms: it records "something changed", starts (at most) one background
//     worker, and prints a short warning about the edited file taken from the last map.
//   * The worker waits for a quiet moment (debounce), rebuilds ONCE for the whole burst of edits at
//     below-normal priority, notes anything that just lost its last reference, and exits. A lock file
//     guarantees two workers never run at once.
//   * On/off is a flag file, so it can be flipped mid-session (CLI, or the `realtime` MCP tool).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStore } from './store.mjs';

const LOCK_STALE_MS = 5 * 60 * 1000;
const NOTE_TTL_MS = 10 * 60 * 1000;
const NOTE_MAX_CHARS = 560;
const NOTES_CAP = 30;

const file = (out, name) => path.join(out, name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function readJson(f, fallback) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
}

function writeJson(f, value) {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, f);
}

// ---------- on / off ----------

export const isEnabled = (out) => readJson(file(out, 'realtime.json'), {}).enabled === true;

export function setEnabled(out, enabled) {
  writeJson(file(out, 'realtime.json'), { enabled: Boolean(enabled), updatedAt: new Date().toISOString() });
}

export function status(out) {
  const s = readJson(file(out, 'realtime.json'), {});
  const notes = readJson(file(out, 'realtime-notes.json'), { items: [] }).items.filter((n) => !n.delivered).length;
  return { enabled: s.enabled === true, updatedAt: s.updatedAt ?? null, rebuilding: lockHeld(out), undeliveredNotes: notes };
}

// ---------- the build lock ----------

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function lockHeld(out) {
  const lock = readJson(file(out, 'build.lock'), null);
  if (!lock) return false;
  if (Date.now() - lock.at > LOCK_STALE_MS || !alive(lock.pid)) { try { unlinkSync(file(out, 'build.lock')); } catch { /* raced */ } return false; }
  return true;
}

function tryLock(out) {
  if (lockHeld(out)) return false;
  mkdirSync(out, { recursive: true });
  try {
    const fd = openSync(file(out, 'build.lock'), 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch { return false; }
}

function releaseLock(out) {
  const lock = readJson(file(out, 'build.lock'), null);
  if (lock?.pid === process.pid) { try { unlinkSync(file(out, 'build.lock')); } catch { /* gone */ } }
}

/** Wait (bounded) for a background build to finish, so a reader never races a half-written map. */
export async function waitForLock(out, maxMs = 30000) {
  const start = Date.now();
  while (lockHeld(out) && Date.now() - start < maxMs) await sleep(150);
  return !lockHeld(out);
}

// ---------- scheduling ----------

/** Record that something changed and make sure exactly one worker will rebuild after it settles. */
export function scheduleRebuild({ root, out, bin }) {
  writeJson(file(out, 'pending.json'), { at: Date.now() });
  if (lockHeld(out)) return 'running';
  const child = spawn(process.execPath, [bin, 'rebuild-worker', '--root', root, '--out', out], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return 'started';
}

function refSnapshot(out) {
  const store = existsSync(file(out, 'stamp.json')) ? loadStore(out) : null;
  return new Map((store?.records ?? []).map((r) => [r.id, r]));
}

function recordOrphans(out, before) {
  const store = existsSync(file(out, 'stamp.json')) ? loadStore(out) : null;
  if (!store) return;
  const fresh = [];
  for (const [id, b] of before) {
    const now = store.byId.get(id);
    if (now && b.prodRefCount > 0 && now.prodRefCount === 0 && !now.entry && !now.history) {
      fresh.push({ id, path: now.path, was: b.prodRefCount, public: Boolean(now.public), at: Date.now(), delivered: false });
    }
  }
  if (!fresh.length) return;
  const notes = readJson(file(out, 'realtime-notes.json'), { items: [] });
  notes.items = [...fresh, ...notes.items].slice(0, NOTES_CAP);
  writeJson(file(out, 'realtime-notes.json'), notes);
}

/**
 * The background worker. Waits for a quiet period, rebuilds once for the whole burst, repeats only if
 * more edits landed during the build. `debounceMs` and `maxWaitMs` are parameters so tests are quick.
 */
export async function runWorker({ root, out, debounceMs = 1500, maxWaitMs = 8000 }) {
  if (!tryLock(out)) return 'busy';
  try {
    try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: fine */ }
    const { buildMap } = await import('./build.mjs');
    for (let round = 0; round < 20; round++) {
      let pending = readJson(file(out, 'pending.json'), null);
      if (!pending) break;
      const started = Date.now();
      for (;;) {
        await sleep(debounceMs);
        const latest = readJson(file(out, 'pending.json'), pending);
        const settled = latest.at === pending.at;
        pending = latest;
        if (settled || Date.now() - started > maxWaitMs) break;
      }
      const before = refSnapshot(out);
      await buildMap({ root, out });
      recordOrphans(out, before);
      const after = readJson(file(out, 'pending.json'), null);
      if (!after || after.at === pending.at) { try { unlinkSync(file(out, 'pending.json')); } catch { /* gone */ } break; }
    }
  } finally { releaseLock(out); }
  return 'done';
}

// ---------- the edit hook ----------

const BORING = new Set(['doc', 'debt', 'doc-drift', 'knip']);

/** A short, rate-limited warning about the file just edited, from the last map. Null when nothing notable. */
export function noteFor({ out, rel }) {
  if (!existsSync(file(out, 'stamp.json'))) return null;
  const store = loadStore(out);
  if (!store) return null;
  const parts = [];

  const records = (store.byPath.get(rel) ?? []).filter((r) => !BORING.has(r.kind));
  const pub = records.filter((r) => r.public);
  if (pub.length) {
    const names = pub.slice(0, 4).map((r) => r.name).join(', ');
    parts.push(`${rel} holds ${pub.length} public record(s) (${names}${pub.length > 4 ? ', …' : ''}): installed clients or outside callers may use them. VERIFY before renaming or removing.`);
  }
  const importers = [...new Set((store.importedBy.get(rel) ?? []).map((i) => i.path).filter((p) => !/\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(p)))];
  if (importers.length >= 5) parts.push(`Imported by ${importers.length} files (${importers.slice(0, 3).join(', ')}, …): check them.`);

  // File-level facts repeat on every edit of the same file, so they are told once per TTL.
  if (parts.length) {
    const state = readJson(file(out, 'realtime-state.json'), {});
    const h = hash(parts.join(' '));
    if (state[rel]?.h === h && Date.now() - state[rel].at < NOTE_TTL_MS) parts.length = 0; // already told the agent
    else { state[rel] = { h, at: Date.now() }; writeJson(file(out, 'realtime-state.json'), state); }
  }

  // Orphans are delivered exactly once, whichever file is edited next.
  const notes = readJson(file(out, 'realtime-notes.json'), { items: [] });
  const fresh = notes.items.filter((n) => !n.delivered);
  if (fresh.length) {
    parts.push(`Since your last edits these lost their last reference: ${fresh.slice(0, 3).map((n) => `${n.id}${n.public ? ' (public: VERIFY)' : ''}`).join(', ')}${fresh.length > 3 ? ` +${fresh.length - 3} more` : ''}.`);
    for (const n of fresh) n.delivered = true;
    writeJson(file(out, 'realtime-notes.json'), notes);
  }
  return parts.length ? `map-it-all: ${parts.join(' ')}`.slice(0, NOTE_MAX_CHARS) : null;
}

/** Walk up from `start` to the nearest folder that already has a map-it-all folder. */
export function findProject(start, outName = '.map-it-all') {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, outName))) return { root: dir, out: path.join(dir, outName) };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The PostToolUse hook entry point. `input` is the hook JSON from Claude Code (tool_input.file_path, cwd).
 * Returns the JSON string to print (additionalContext is the only way context reaches Claude), or ''.
 * Never throws: a hook must not be able to get in the way of an edit.
 */
export function handleEdit(input, { bin }) {
  try {
    const project = findProject(input.cwd || process.cwd());
    if (!project || !isEnabled(project.out)) return '';
    const target = input.tool_input?.file_path;
    if (typeof target !== 'string' || !target) return '';
    const rel = path.relative(project.root, path.resolve(project.root, target)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /(^|\/)(node_modules|\.git|\.map-it-all)\//.test(rel)) return '';
    scheduleRebuild({ root: project.root, out: project.out, bin });
    const note = noteFor({ out: project.out, rel });
    return note ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }) : '';
  } catch { return ''; }
}
