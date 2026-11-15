// Realtime mode: toggle, lock, the edit hook, and the background worker, end to end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../src/build.mjs';
import { handleEdit, isEnabled, lockHeld, runWorker, setEnabled, status, waitForLock } from '../src/realtime.mjs';
import { loadStore } from '../src/store.mjs';
import { fixture, write } from './fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.MAP_IT_ALL_DEBOUNCE_MS = '80'; // the worker the hook spawns inherits this

async function project() {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  await buildMap({ root, out });
  return { root, out };
}

/** Wait until the background worker has finished and cleared its pending marker. */
async function settle(out) {
  for (let i = 0; i < 200; i++) {
    if (!existsSync(path.join(out, 'pending.json')) && !lockHeld(out)) return;
    await sleep(100);
  }
  throw new Error('background worker did not settle');
}

const edit = (root, rel) => ({ cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, rel) } });

test('realtime is off until switched on, and the switch is a plain file', async () => {
  const { root, out } = await project();
  try {
    assert.equal(isEnabled(out), false);
    setEnabled(out, true);
    assert.equal(isEnabled(out), true);
    assert.deepEqual({ ...status(out), updatedAt: null }, { enabled: true, updatedAt: null, rebuilding: false, undeliveredNotes: 0 });
    setEnabled(out, false);
    assert.equal(isEnabled(out), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('while off, the hook does nothing at all: no worker, no pending marker, no output', async () => {
  const { root, out } = await project();
  try {
    assert.equal(handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }), '');
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('the hook ignores files outside the project, the map folder and node_modules', async () => {
  const { root, out } = await project();
  try {
    setEnabled(out, true);
    for (const target of [path.join(path.dirname(root), 'elsewhere.ts'), path.join(out, 'x.json'), path.join(root, 'node_modules', 'pkg', 'index.js')]) {
      assert.equal(handleEdit({ cwd: root, tool_input: { file_path: target } }, { bin: BIN }), '');
    }
    assert.equal(existsSync(path.join(out, 'pending.json')), false, 'nothing was scheduled');
    assert.equal(handleEdit({ cwd: root, tool_input: {} }, { bin: BIN }), '', 'no file path: nothing to do');
    assert.equal(handleEdit({}, { bin: BIN }), '', 'no cwd and not a project: silent');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('an edit refreshes the map in the background, then the next edit hears what was orphaned', async () => {
  const { root, out } = await project();
  try {
    setEnabled(out, true);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 1);

    // The agent deletes the only caller of convex:lib.used.
    rmSync(path.join(root, 'web', 'call.ts'));
    const t0 = performance.now();
    const first = handleEdit(edit(root, 'web/call.ts'), { bin: BIN });
    const hookMs = performance.now() - t0;
    assert.equal(first, '', 'nothing notable about the edited file itself');
    assert.ok(hookMs < 500, `the hook returns quickly (${Math.round(hookMs)} ms)`);
    assert.ok(existsSync(path.join(out, 'pending.json')), 'the change was recorded for the worker');

    await settle(out);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0, 'the worker rebuilt the map');
    assert.equal(status(out).undeliveredNotes, 1);

    // The next edit (in a file with public records) delivers the warning, once.
    const second = JSON.parse(handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }));
    assert.equal(second.hookSpecificOutput.hookEventName, 'PostToolUse');
    const note = second.hookSpecificOutput.additionalContext;
    assert.match(note, /^map-it-all: /);
    assert.match(note, /convex\/lib\.ts holds \d+ public record/);
    assert.match(note, /lost their last reference: convex:lib\.used \(public: VERIFY\)/);
    assert.ok(note.length <= 560, 'the note stays within its token budget');
    assert.equal(status(out).undeliveredNotes, 0);

    // Editing the same file again must not repeat the same warning.
    assert.equal(handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }), '', 'no repeat');
    await settle(out);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('only one worker runs at a time, a stale lock is ignored, and readers can wait for a build', async () => {
  const { root, out } = await project();
  try {
    writeFileSync(path.join(out, 'pending.json'), JSON.stringify({ at: Date.now() }));
    const [a, b] = await Promise.all([runWorker({ root, out, debounceMs: 60 }), runWorker({ root, out, debounceMs: 60 })]);
    assert.deepEqual([a, b].sort(), ['busy', 'done'], 'exactly one worker did the work');
    assert.equal(lockHeld(out), false, 'the lock is released');

    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'build.lock'), JSON.stringify({ pid: 2147483646, at: Date.now() }));
    assert.equal(lockHeld(out), false, 'a lock owned by a dead process is stale');
    writeFileSync(path.join(out, 'build.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.equal(lockHeld(out), true);
    setTimeout(() => rmSync(path.join(out, 'build.lock'), { force: true }), 200);
    assert.equal(await waitForLock(out, 3000), true, 'waitForLock returns once the build finishes');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('a burst of edits is coalesced into one rebuild', async () => {
  const { root, out } = await project();
  try {
    const stamp = () => JSON.parse(readFileSync(path.join(out, 'stamp.json'), 'utf8')).generatedAt;
    const before = stamp();
    writeFileSync(path.join(out, 'pending.json'), JSON.stringify({ at: 1 }));
    const worker = runWorker({ root, out, debounceMs: 250, maxWaitMs: 5000 });
    for (let i = 2; i <= 6; i++) { await sleep(60); writeFileSync(path.join(out, 'pending.json'), JSON.stringify({ at: i })); }
    assert.equal(await worker, 'done');
    assert.notEqual(stamp(), before, 'rebuilt');
    assert.equal(existsSync(path.join(out, 'pending.json')), false, 'all five later edits were covered by that one build');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('`touch` as a real process: valid output or silence, always exit 0, even on garbage input', async () => {
  const { root, out } = await project();
  try {
    const run = (input) => spawnSync(process.execPath, [BIN, 'touch'], { input, encoding: 'utf8', cwd: root });
    assert.equal(run('not json at all').status, 0);
    assert.equal(run('').stdout, '');
    assert.equal(run(JSON.stringify(edit(root, 'convex/lib.ts'))).stdout, '', 'off: silent');
    setEnabled(out, true);
    const t0 = performance.now();
    const r = run(JSON.stringify(edit(root, 'convex/lib.ts')));
    const ms = performance.now() - t0;
    assert.equal(r.status, 0);
    if (r.stdout) assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(ms < 1500, `a cold-start hook call stays fast (${Math.round(ms)} ms)`);
    await settle(out);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});
