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
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore } from './store.mjs';
import { acquireBuildLock, acquireNamedLock, buildLockHeld, lockHeld, releaseBuildLock, waitForBuildLock } from './build-lock.mjs';

export { lockHeld };

const NOTE_TTL_MS = 10 * 60 * 1000;
const NOTE_MAX_CHARS = 560;
const NOTES_CAP = 30;
const DEFAULT_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/map-it-all.mjs');

const file = (out, name) => path.join(out, name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function readJson(f, fallback) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
}

function writeJson(f, value) {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, f);
}

const pendingFile = (out) => file(out, 'pending.json');
const claimPrefix = 'pending.claim.';
const claimFiles = (out) => readdirSync(out).filter((name) => name.startsWith(claimPrefix) && name.endsWith('.json')).map((name) => file(out, name));
const newPending = () => ({ at: Date.now(), generation: randomUUID() });

/** Move the queue marker out atomically, leaving a fresh path for the next touch. */
function claimPending(out) {
  const claim = file(out, `${claimPrefix}${randomUUID()}.json`);
  try {
    renameSync(pendingFile(out), claim);
    let marker = readJson(claim, null);
    if (typeof marker?.generation !== 'string') {
      marker = { ...(marker ?? {}), at: marker?.at ?? Date.now(), generation: randomUUID() };
      writeJson(claim, marker);
    }
    return { path: claim, marker };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Recover interrupted claims without replacing a newer queued marker. */
function recoverClaims(out, claims = claimFiles(out)) {
  for (const claim of claims) {
    if (!existsSync(claim)) continue;
    const claimed = readJson(claim, null);
    const queued = readJson(pendingFile(out), null);
    if (typeof queued?.generation === 'string' && typeof claimed?.generation === 'string'
      && (queued.generation === claimed.generation || (Number.isFinite(queued.at) && Number.isFinite(claimed.at) && queued.at > claimed.at))) {
      // Drop a claim only when the queue repeats it or is provably newer. An
      // unreadable/partial/ambiguous marker is not proof that the claim is safe to drop.
      try { unlinkSync(claim); } catch { /* already gone */ }
      continue;
    }
    if (existsSync(pendingFile(out))) continue;
    let fd;
    try { fd = openSync(pendingFile(out), 'wx'); } catch (error) {
      if (error.code === 'EEXIST') {
        const raced = readJson(pendingFile(out), null);
        if (typeof raced?.generation === 'string' && typeof claimed?.generation === 'string'
          && (raced.generation === claimed.generation || (Number.isFinite(raced.at) && Number.isFinite(claimed.at) && raced.at > claimed.at))) { try { unlinkSync(claim); } catch {} }
      }
      continue;
    }
    try { writeFileSync(fd, readFileSync(claim)); }
    catch (error) { try { unlinkSync(pendingFile(out)); } catch {} throw error; }
    finally { closeSync(fd); }
    try { unlinkSync(claim); } catch { /* already gone */ }
  }
}

async function launchWorker(root, out, bin = DEFAULT_BIN) {
  const ready = file(out, `worker-ready.${randomUUID()}`);
  let child;
  try {
    child = spawn(process.execPath, [path.resolve(bin), 'rebuild-worker', '--root', path.resolve(root), '--out', path.resolve(out), '--worker-ready', ready], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { return false; }
  // Keep the start lock through the child's worker-lock acknowledgment. This short
  // bound keeps edit hooks responsive; a later touch retries a startup that missed it.
  const until = performance.now() + 350;
  while (performance.now() < until) {
    if (existsSync(ready)) { try { unlinkSync(ready); } catch {} return true; }
    if (child.exitCode !== null) return false;
    await sleep(15);
  }
  if (existsSync(ready)) { try { unlinkSync(ready); } catch {} return true; }
  // The process was launched and may still be starting under heavy load. The
  // durable pending marker remains the retry signal if it later exits before ready.
  return child.exitCode === null;
}

// ---------- on / off ----------

export const isEnabled = (out) => readJson(file(out, 'realtime.json'), {}).enabled === true;

export function setEnabled(out, enabled) {
  writeJson(file(out, 'realtime.json'), { enabled: Boolean(enabled), updatedAt: new Date().toISOString() });
}

export async function status(out) {
  const s = readJson(file(out, 'realtime.json'), {});
  const notes = readJson(file(out, 'realtime-notes.json'), { items: [] }).items.filter((n) => !n.delivered).length;
  return { enabled: s.enabled === true, updatedAt: s.updatedAt ?? null, rebuilding: await buildLockHeld(out), undeliveredNotes: notes };
}

// ---------- the build lock ----------

/** Wait (bounded) for a background build to finish, so a reader never races a half-written map. */
export async function waitForLock(out, maxMs = 30000) {
  return waitForBuildLock(out, maxMs);
}

// ---------- scheduling ----------

/** Record that something changed and make sure exactly one worker will rebuild after it settles. */
export async function scheduleRebuild({ root, out, bin }) {
  writeJson(pendingFile(out), newPending());
  return await requestWorker(root, out, bin) ? 'started' : 'running';
}

async function requestWorker(root, out, bin) {
  const start = await acquireNamedLock(out, 'worker-start.lock', { wait: false });
  if (!start) return false;
  try {
    // A live worker already owns the election lock, including while it waits
    // behind an ordinary build. The start lock serializes this probe with launches.
    const probe = await acquireNamedLock(out, 'worker.lock', { wait: false });
    if (!probe) return false;
    await releaseBuildLock(probe);
    return await launchWorker(root, out, bin);
  }
  finally { await releaseBuildLock(start); }
}

/** Release handoff used by ordinary builds that saw a touch while holding the shared lock. */
export async function handoffQueuedWork({ root, out, bin }) {
  if (!existsSync(pendingFile(out)) && claimFiles(out).length === 0) return false;
  return requestWorker(root, out, bin);
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
export async function runWorker({ root, out, debounceMs = 1500, maxWaitMs = 8000, build: buildOverride, wait = sleep, now = () => performance.now(), hooks = {}, bin, lockWait = false, readyFile }) {
  const startupDelay = Number(process.env.MAP_IT_ALL_TEST_WORKER_START_DELAY_MS);
  if (Number.isFinite(startupDelay) && startupDelay > 0) await sleep(Math.min(startupDelay, 5000));
  // Lock order is always worker election, then shared publication lock. The worker
  // election lock spans debounce and any wait for an ordinary writer.
  // Never queue another worker behind a live worker. Launchers serialize startup
  // and the elected child acknowledges only after owning this lock.
  const worker = await acquireNamedLock(out, 'worker.lock', { wait: false });
  if (!worker) return 'busy';
  if (readyFile) { try { writeFileSync(readyFile, String(process.pid)); } catch {} }
  let owner;
  let succeeded = false;
  let operationError;
  try {
    owner = await acquireBuildLock(out, { wait: lockWait });
    if (!owner) { await releaseBuildLock(worker); return 'busy'; }
    try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: fine */ }
    recoverClaims(out);
    const { buildMap: defaultBuild } = buildOverride ? {} : await import('./build.mjs');
    const buildMap = buildOverride ?? defaultBuild;
    for (let round = 0; round < 20; round++) {
      const first = claimPending(out);
      if (!first) break;
      const claims = [first.path];
      let pending = first.marker ?? newPending();
      await hooks.afterClaim?.({ root, out, round, marker: pending });
      const started = now();
      for (;;) {
        const remaining = Math.max(0, maxWaitMs - (now() - started));
        if (remaining === 0) break;
        await wait(Math.min(debounceMs, remaining));
        const latest = claimPending(out);
        if (!latest) break;
        claims.push(latest.path);
        const settled = latest.marker?.generation === pending.generation;
        pending = latest.marker ?? pending;
        if (settled || now() - started >= maxWaitMs) break;
      }
      const before = refSnapshot(out);
      try {
        await hooks.beforeBuild?.({ root, out, round, marker: pending });
        await buildMap({ root, out, buildLock: owner });
        recordOrphans(out, before);
        for (const claim of claims) { try { unlinkSync(claim); } catch { /* gone */ } }
        await hooks.afterBuild?.({ root, out, round, marker: pending });
      } catch (error) {
        recoverClaims(out, claims);
        throw error;
      }
    }
    succeeded = true;
  } catch (error) { operationError = error; }
  const cleanupErrors = [];
  try { await hooks.beforeRelease?.({ root, out }); } catch (error) { cleanupErrors.push(error); }
  if (owner) try { await releaseBuildLock(owner); } catch (error) { cleanupErrors.push(error); }
  try { await hooks.afterRelease?.({ root, out }); } catch (error) { cleanupErrors.push(error); }
  try { await releaseBuildLock(worker); } catch (error) { cleanupErrors.push(error); }
  if (readyFile) { try { unlinkSync(readyFile); } catch {} }
  // Recheck after both locks release; touches racing the last queue scan remain durable.
  if (succeeded && worker.ownershipReleased && (!owner || owner.ownershipReleased) && (existsSync(pendingFile(out)) || claimFiles(out).length)) {
    try {
      if (hooks.onHandoff) await hooks.onHandoff({ root, out });
      else await handoffQueuedWork({ root, out, bin });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (operationError) {
    try { writeJson(file(out, 'realtime-error.json'), { at: new Date().toISOString(), message: String(operationError.stack ?? operationError) }); }
    catch (error) { cleanupErrors.push(error); }
  } else if (succeeded && !cleanupErrors.length) {
    try { unlinkSync(file(out, 'realtime-error.json')); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); }
  }
  if (operationError && cleanupErrors.length) {
    Object.defineProperty(operationError, 'cleanupErrors', { value: cleanupErrors, configurable: true });
    throw operationError;
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Worker cleanup failed');
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
export async function handleEdit(input, { bin }) {
  try {
    const project = findProject(input.cwd || process.cwd());
    if (!project || !isEnabled(project.out)) return '';
    const target = input.tool_input?.file_path;
    if (typeof target !== 'string' || !target) return '';
    const rel = path.relative(project.root, path.resolve(project.root, target)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /(^|\/)(node_modules|\.git|\.map-it-all)\//.test(rel)) return '';
    await scheduleRebuild({ root: project.root, out: project.out, bin });
    const note = noteFor({ out: project.out, rel });
    return note ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }) : '';
  } catch { return ''; }
}
