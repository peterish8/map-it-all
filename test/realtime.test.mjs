// Realtime mode: toggle, lock, the edit hook, and the background worker, end to end.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../src/build.mjs';
import { acquireBuildLock, buildLockHeld, releaseBuildLock } from '../src/build-lock.mjs';
import { createServer } from '../src/mcp.mjs';
import { handleEdit, handoffQueuedWork, isEnabled, lockHeld, runWorker, scheduleRebuild, setEnabled, status, waitForLock } from '../src/realtime.mjs';
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
async function settle(out, root) {
  const deadline = Date.now() + 60000;
  let recoveryRequested = false;
  while (Date.now() < deadline) {
    const claims = readdirSync(out).filter((name) => name.startsWith('pending.claim.') && name.endsWith('.json'));
    if (!existsSync(path.join(out, 'pending.json')) && claims.length && !recoveryRequested && !await buildLockHeld(out)) {
      recoveryRequested = true;
      await handoffQueuedWork({ root, out, bin: BIN });
    }
    if (!existsSync(path.join(out, 'pending.json')) && claims.length === 0 && !await buildLockHeld(out)) return;
    await sleep(100);
  }
  throw new Error(`background worker did not settle (pending=${existsSync(path.join(out, 'pending.json'))}, claims=${readdirSync(out).filter((name) => name.startsWith('pending.claim.')).length}, lock=${lockHeld(out)}); fixture retained at ${root}`);
}

async function removeFixture(root) {
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= maxAttempts) throw error;
      await sleep(100);
    }
  }
}

async function cleanup(root, out, primaryError) {
  try {
    await settle(out, root);
  } catch (error) {
    if (primaryError) {
      primaryError.message += `; cleanup also failed: ${error.message}`;
      return;
    }
    throw error;
  }
  try {
    await removeFixture(root);
  } catch (error) {
    if (primaryError) {
      primaryError.message += `; fixture cleanup failed at ${root}: ${error.message}`;
      return;
    }
    throw new Error(`could not remove fixture at ${root}: ${error.message}`, { cause: error });
  }
}

const edit = (root, rel) => ({ cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, rel) } });
const queue = (out, generation = `test-${Math.random()}`) => writeFileSync(path.join(out, 'pending.json'), JSON.stringify({ at: Date.now(), generation }));

test('realtime is off until switched on, and the switch is a plain file', async () => {
  const { root, out } = await project();
  try {
    assert.equal(isEnabled(out), false);
    setEnabled(out, true);
    assert.equal(isEnabled(out), true);
    assert.deepEqual({ ...(await status(out)), updatedAt: null }, { enabled: true, updatedAt: null, rebuilding: false, undeliveredNotes: 0 });
    setEnabled(out, false);
    assert.equal(isEnabled(out), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('while off, the hook does nothing at all: no worker, no pending marker, no output', async () => {
  const { root, out } = await project();
  try {
    assert.equal(await handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }), '');
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('the hook ignores files outside the project, the map folder and node_modules', async () => {
  const { root, out } = await project();
  try {
    setEnabled(out, true);
    for (const target of [path.join(path.dirname(root), 'elsewhere.ts'), path.join(out, 'x.json'), path.join(root, 'node_modules', 'pkg', 'index.js')]) {
      assert.equal(await handleEdit({ cwd: root, tool_input: { file_path: target } }, { bin: BIN }), '');
    }
    assert.equal(existsSync(path.join(out, 'pending.json')), false, 'nothing was scheduled');
    assert.equal(await handleEdit({ cwd: root, tool_input: {} }, { bin: BIN }), '', 'no file path: nothing to do');
    assert.equal(await handleEdit({}, { bin: BIN }), '', 'no cwd and not a project: silent');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('an edit refreshes the map in the background, then the next edit hears what was orphaned', async () => {
  const { root, out } = await project();
  let primaryError;
  try {
    setEnabled(out, true);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 1);

    // The agent deletes the only caller of convex:lib.used.
    rmSync(path.join(root, 'web', 'call.ts'));
    const t0 = performance.now();
    const first = await handleEdit(edit(root, 'web/call.ts'), { bin: BIN });
    const hookMs = performance.now() - t0;
    assert.equal(first, '', 'nothing notable about the edited file itself');
    assert.ok(hookMs < 500, `the hook returns quickly (${Math.round(hookMs)} ms)`);
    assert.ok(existsSync(path.join(out, 'pending.json')) || readdirSync(out).some((name) => name.startsWith('pending.claim.')), 'the change was durably queued or claimed by the worker');

    await settle(out);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0, 'the worker rebuilt the map');
    assert.equal((await status(out)).undeliveredNotes, 1);

    // The next edit (in a file with public records) delivers the warning, once.
    const second = JSON.parse(await handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }));
    assert.equal(second.hookSpecificOutput.hookEventName, 'PostToolUse');
    const note = second.hookSpecificOutput.additionalContext;
    assert.match(note, /^map-it-all: /);
    assert.match(note, /convex\/lib\.ts holds \d+ public record/);
    assert.match(note, /lost their last reference: convex:lib\.used \(public: VERIFY\)/);
    assert.ok(note.length <= 560, 'the note stays within its token budget');
    assert.equal((await status(out)).undeliveredNotes, 0);

    // Editing the same file again must not repeat the same warning.
    assert.equal(await handleEdit(edit(root, 'convex/lib.ts'), { bin: BIN }), '', 'no repeat');
    await settle(out);
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanup(root, out, primaryError); }
});

test('a long-aged live owner stays locked, crashes recover through the OS lock, and non-owners cannot release it', async () => {
  const { root, out } = await project();
  try {
    writeFileSync(path.join(out, 'pending.json'), JSON.stringify({ at: Date.now(), generation: 'initial' }));
    const held = await acquireBuildLock(out);
    const metadataPath = path.join(out, 'build.lock.owner.json');
    writeFileSync(metadataPath, JSON.stringify({ pid: process.pid, at: 0 }));
    const [a, b] = await Promise.all([runWorker({ root, out, debounceMs: 60 }), runWorker({ root, out, debounceMs: 60 })]);
    assert.deepEqual([a, b], ['busy', 'busy'], 'neither contender overlaps the active owner');
    assert.equal(await releaseBuildLock({ ...held, owner: 'not-the-owner' }), false, 'a copied non-owner handle cannot release the lock');
    assert.equal(await runWorker({ root, out, debounceMs: 0, wait: async () => {} }), 'busy', 'a live kernel lock remains busy regardless of sidecar PID');
    assert.equal(await releaseBuildLock(held), true);
    assert.equal(lockHeld(out), false);

    const source = `import { acquireBuildLock } from './src/build-lock.mjs';\nimport { writeFileSync } from 'node:fs';\nawait acquireBuildLock(process.argv[1]); writeFileSync(process.argv[2],'ready'); setInterval(()=>{},1000);`;
    const ready = path.join(out, 'child-ready');
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, out, ready], { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), stdio: 'ignore', windowsHide: true });
    const childExit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await sleep(10);
    assert.ok(existsSync(ready), 'child acquired the OS-managed lock');
    assert.equal((await status(out)).rebuilding, true, 'an immediate kernel-lock probe sees a cross-process owner without trusting PID metadata');
    child.kill();
    await childExit;
    assert.equal((await status(out)).rebuilding, false, 'a crashed owner releases the OS lock');
    const recovered = await acquireBuildLock(out, { wait: false });
    assert.ok(recovered, 'the OS releases the abandoned lock after process death');
    assert.equal(await releaseBuildLock(recovered), true);
    const releaseFile = path.join(out, 'contenders-release');
    const contenderSource = `import { acquireBuildLock, releaseBuildLock } from './src/build-lock.mjs';\nimport { existsSync, writeFileSync } from 'node:fs';\nconst h=await acquireBuildLock(process.argv[1],{wait:false}); writeFileSync(process.argv[2],h?'won':'busy'); if(h){while(!existsSync(process.argv[3])) await new Promise(r=>setTimeout(r,5)); await releaseBuildLock(h)}`;
    const contenders = Array.from({ length: 4 }, (_, i) => {
      const result = path.join(out, `contender-${i}.result`);
      const child = spawn(process.execPath, ['--input-type=module', '-e', contenderSource, out, result, releaseFile], { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), stdio: 'ignore', windowsHide: true });
      const exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      return { child, result, exit };
    });
    const contenderDeadline = Date.now() + 5000;
    while (contenders.some(({ result }) => !existsSync(result)) && Date.now() < contenderDeadline) await sleep(10);
    assert.ok(contenders.every(({ result }) => existsSync(result)), 'each child reached the contention barrier');
    assert.equal(contenders.filter(({ result }) => readFileSync(result, 'utf8') === 'won').length, 1, 'exactly one independent process owns the recovered lock');
    writeFileSync(releaseFile, 'release');
    await Promise.all(contenders.map(({ exit }) => exit));
    const [c, d] = await Promise.all([runWorker({ root, out, debounceMs: 0, wait: async () => {} }), runWorker({ root, out, debounceMs: 0, wait: async () => {} })]);
    assert.deepEqual([c, d].sort(), ['busy', 'done'], 'simultaneous workers choose one owner after recovery');
    assert.equal(await waitForLock(out, 3000), true, 'waitForLock returns once the build finishes');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('lock setup failure releases the local queue and stale PID sidecars are not lock truth', async () => {
  const { root, out } = await project();
  try {
    const lockPath = path.join(out, 'build.lock');
    unlinkSync(lockPath);
    mkdirSync(lockPath);
    await assert.rejects(acquireBuildLock(out), /EISDIR|EEXIST|directory|invalid argument/i);
    rmSync(lockPath, { recursive: true, force: true });
    writeFileSync(`${lockPath}.owner.json`, JSON.stringify({ pid: process.pid, at: 0 }));
    const recovered = await acquireBuildLock(out, { wait: false });
    assert.ok(recovered, 'a failed setup released the same-process reservation and stale PID data does not suppress acquisition');
    assert.equal(await acquireBuildLock(out, { wait: false }), null, 'the live kernel lock blocks a second same-process descriptor');
    assert.equal(await releaseBuildLock(recovered), true);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('a burst of edits is coalesced into one rebuild', async () => {
  const { root, out } = await project();
  try {
    const stamp = () => JSON.parse(readFileSync(path.join(out, 'stamp.json'), 'utf8')).generatedAt;
    const before = stamp();
    queue(out, 'burst-initial');
    let waitRound = 0;
    const worker = runWorker({ root, out, debounceMs: 0, maxWaitMs: 1000, wait: async () => {
      if (++waitRound <= 5) await scheduleRebuild({ root, out, bin: BIN });
    } });
    assert.equal(await worker, 'done');
    assert.notEqual(stamp(), before, 'rebuilt');
    assert.equal(waitRound, 6, 'the worker observed the whole burst before rebuilding');
    assert.equal(existsSync(path.join(out, 'pending.json')), false, 'all burst edits were covered by one build');
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('continuous edits hit maxWaitMs exactly, while quiet input builds early and the last wait is capped', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'max-wait-initial');
    let clock = 0;
    const waits = [];
    let buildAt;
    const result = await runWorker({ root, out, debounceMs: 10, maxWaitMs: 25, now: () => clock,
      wait: async (ms) => { waits.push(ms); clock += ms; await scheduleRebuild({ root, out, bin: BIN }); },
      build: async (args) => { buildAt = clock; await buildMap(args); },
    });
    assert.equal(result, 'done');
    assert.deepEqual(waits, [10, 10, 5], 'non-divisible remaining time is waited exactly');
    assert.equal(buildAt, 25, 'the build starts at the max-wait deadline while edits continue');

    queue(out, 'quiet-before-deadline');
    clock = 0;
    waits.length = 0;
    await runWorker({ root, out, debounceMs: 7, maxWaitMs: 30, now: () => clock,
      wait: async (ms) => { waits.push(ms); clock += ms; },
      build: async (args) => { buildAt = clock; await buildMap(args); },
    });
    assert.deepEqual(waits, [7]);
    assert.equal(buildAt, 7, 'quiet input builds before the max-wait deadline');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('MCP refresh waits behind a realtime build using the same output lock', async () => {
  const { root, out } = await project();
  let unblock;
  let started;
  const reachedBuild = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { unblock = resolve; });
  try {
    queue(out, 'mcp-realtime-overlap');
    const realtime = runWorker({ root, out, debounceMs: 0, wait: async () => {}, build: async (args) => {
      started();
      await hold;
      await buildMap(args);
    } });
    await reachedBuild;
    const refresh = createServer({ root, outOverride: out, profile: 'full' }).allTools.find((tool) => tool.name === 'refresh');
    let finished = false;
    const mcpBuild = refresh.run({}).then((value) => { finished = true; return value; });
    await new Promise(setImmediate);
    assert.equal(finished, false, 'MCP cannot start its map write while realtime owns the OS lock');
    unblock();
    assert.equal(await realtime, 'done');
    assert.match(await mcpBuild, /^rebuilt in /);
    assert.equal(lockHeld(out), false);
  } finally {
    unblock?.();
    await rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});

test('MCP map reads wait through a mixed publication and return one complete generation', async () => {
  const { root, out } = await project();
  const futureOut = path.join(root, 'future-map');
  let owner;
  try {
    write(root, 'convex/lib.ts', `${readFileSync(path.join(root, 'convex/lib.ts'), 'utf8')}\nexport const newlyAdded = query({ handler: async () => 5 });\n`);
    await buildMap({ root, out: futureOut });
    owner = await acquireBuildLock(out);
    // Simulate a publisher paused after replacing its first output, before stamp.json.
    copyFileSync(path.join(futureOut, 'convex.json'), path.join(out, 'convex.json'));
    const find = createServer({ root, outOverride: out, profile: 'full' }).allTools.find((tool) => tool.name === 'find');
    let finished = false;
    const pending = find.run({ query: 'newlyAdded' }).then((text) => { finished = true; return text; });
    await new Promise(setImmediate);
    assert.equal(finished, false, 'the MCP reader cannot observe publication while the writer holds build.lock');
    for (const name of readdirSync(futureOut).filter((name) => name !== 'convex.json' && name !== 'stamp.json')) {
      copyFileSync(path.join(futureOut, name), path.join(out, name));
    }
    copyFileSync(path.join(futureOut, 'stamp.json'), path.join(out, 'stamp.json'));
    await releaseBuildLock(owner);
    owner = null;
    assert.match(await pending, /convex:lib\.newlyAdded/);
  } finally {
    if (owner) await releaseBuildLock(owner);
    await removeFixture(root);
  }
});

test('a fresh MCP map read hands off queued realtime work after releasing its read lock', async () => {
  const { root, out } = await project();
  let owner;
  try {
    owner = await acquireBuildLock(out);
    queue(out, 'fresh-mcp-handoff');
    const find = createServer({ root, outOverride: out }).allTools.find((tool) => tool.name === 'find');
    let finished = false;
    const pending = find.run({ query: 'used' }).then((value) => { finished = true; return value; });
    await new Promise(setImmediate);
    assert.equal(finished, false, 'MCP waits for the current writer lock even when the map is fresh');
    await releaseBuildLock(owner);
    owner = null;
    assert.match(await pending, /convex:lib\.used/);
    await settle(out, root);
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } finally {
    if (owner) await releaseBuildLock(owner);
    await removeFixture(root);
  }
});

test('a touch after claim during a build stays queued and the same worker builds it without overlap', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'build-race-initial');
    let builds = 0;
    let active = 0;
    let maxActive = 0;
    const worker = runWorker({ root, out, debounceMs: 0, wait: async () => {}, build: async (args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      builds++;
      if (builds === 1) {
        writeFileSync(path.join(root, 'web', 'call.ts'), 'export const x = 2;\n');
        assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'running');
      }
      await buildMap(args);
      active--;
    } });
    assert.equal(await worker, 'done');
    assert.equal(builds, 2, 'the edit made during build caused another round');
    assert.equal(maxActive, 1, 'only one builder was active');
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0, 'final map reflects the second edit');
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('a touch while the lock is held at release is handed to one competing start', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'release-gap-initial');
    let builds = 0;
    let active = 0;
    let maxActive = 0;
    let touched = false;
    const build = async (args) => { active++; maxActive = Math.max(maxActive, active); builds++; await buildMap(args); active--; };
    const successor = { root, out, debounceMs: 0, wait: async () => {}, build };
    const first = runWorker({ ...successor, hooks: {
      beforeRelease: async () => {
        writeFileSync(path.join(root, 'web', 'call.ts'), 'export const x = 2;\n');
        assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'running');
        touched = true;
      },
      onHandoff: async () => {
        const results = await Promise.all([runWorker(successor), runWorker(successor)]);
        assert.deepEqual(results.sort(), ['busy', 'done']);
      },
    } });
    assert.equal(await first, 'done');
    assert.equal(touched, true);
    assert.equal(builds, 2);
    assert.equal(maxActive, 1);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0, 'successor map reflects the release-gap edit');
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('an edit queued behind an ordinary build drains on release without another touch', async () => {
  const { root, out } = await project();
  let primaryError;
  try {
    const owner = await acquireBuildLock(out);
    await buildMap({ root, out, buildLock: owner, buildLockHandoff: true }); // ordinary build registers the shared release handoff
    writeFileSync(path.join(root, 'web', 'call.ts'), 'export const x = 2;\n');
    assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'started', 'the worker is elected while the ordinary build owns build.lock and waits behind it');
    assert.ok(existsSync(path.join(out, 'pending.json')) || readdirSync(out).some((name) => name.startsWith('pending.claim.')));
    await releaseBuildLock(owner);
    await settle(out, root);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0, 'the released ordinary build automatically handed pending work to realtime');
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanup(root, out, primaryError); }
});

test('an ordinary build hands off a claim-only queue left by a crashed worker', async () => {
  const { root, out } = await project();
  let primaryError;
  try {
    writeFileSync(path.join(out, 'pending.claim.crashed.json'), JSON.stringify({ at: Date.now() - 1000, generation: 'crashed-generation' }));
    await buildMap({ root, out });
    await settle(out, root);
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanup(root, out, primaryError); }
});

test('concurrent touches elect one detached worker through the shared lock', async () => {
  const { root, out } = await project();
  let primaryError;
  try {
    writeFileSync(path.join(root, 'web', 'call.ts'), 'export const x = 2;\n');
    const launches = await Promise.all([
      scheduleRebuild({ root, out, bin: BIN }),
      scheduleRebuild({ root, out, bin: BIN }),
    ]);
    assert.deepEqual(launches.sort(), ['running', 'started'], 'only the reservation owner starts a worker');
    await settle(out, root);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0);
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanup(root, out, primaryError); }
});

test('independent touches during an ordinary build share one acknowledged waiting worker', async () => {
  const { root, out } = await project();
  let owner;
  let primaryError;
  try {
    owner = await acquireBuildLock(out);
    writeFileSync(path.join(root, 'web', 'call.ts'), 'export const x = 2;\n');
    const priorDelay = process.env.MAP_IT_ALL_TEST_WORKER_START_DELAY_MS;
    process.env.MAP_IT_ALL_TEST_WORKER_START_DELAY_MS = '120';
    let results;
    try { results = await Promise.all(Array.from({ length: 9 }, () => scheduleRebuild({ root, out, bin: BIN }))); }
    finally {
      if (priorDelay === undefined) delete process.env.MAP_IT_ALL_TEST_WORKER_START_DELAY_MS;
      else process.env.MAP_IT_ALL_TEST_WORKER_START_DELAY_MS = priorDelay;
    }
    assert.equal(results.filter((x) => x === 'started').length, 1, 'one launcher holds the start lock through worker-lock acknowledgment');
    assert.ok(results.every((x) => x === 'started' || x === 'running'));
    await releaseBuildLock(owner);
    owner = null;
    await settle(out, root);
    assert.equal(loadStore(out).byId.get('convex:lib.used').prodRefCount, 0);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } catch (error) { primaryError = error; throw error; }
  finally {
    if (owner) await releaseBuildLock(owner);
    await cleanup(root, out, primaryError);
  }
});

test('a touch immediately after release is caught by the post-release handoff and stays single-writer', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'after-release-initial');
    let builds = 0;
    let active = 0;
    let maxActive = 0;
    const build = async (args) => { active++; maxActive = Math.max(maxActive, active); builds++; await buildMap(args); active--; };
    const successor = { root, out, debounceMs: 0, wait: async () => {}, build };
    const first = runWorker({ ...successor, hooks: {
      afterRelease: () => queue(out, 'touch-on-after-release-barrier'),
      onHandoff: async () => { assert.equal(await runWorker(successor), 'done'); },
    } });
    assert.equal(await first, 'done');
    assert.equal(builds, 2);
    assert.equal(maxActive, 1);
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('same-millisecond touches have distinct generations', async () => {
  const { root, out } = await project();
  try {
    const held = await acquireBuildLock(out);
    const now = Date.now;
    Date.now = () => 123456;
    try {
      assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'started');
      const first = JSON.parse(readFileSync(path.join(out, 'pending.json'), 'utf8'));
      assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'running');
      const second = JSON.parse(readFileSync(path.join(out, 'pending.json'), 'utf8'));
      assert.equal(first.at, second.at);
      assert.notEqual(first.generation, second.generation);
    } finally { Date.now = now; await releaseBuildLock(held); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('failed builds restore their claimed work and clear the claim marker', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'failed-build-generation');
    const generation = JSON.parse(readFileSync(path.join(out, 'pending.json'), 'utf8')).generation;
    await assert.rejects(runWorker({ root, out, debounceMs: 0, wait: async () => {}, build: async () => { throw new Error('build failed'); } }), /build failed/);
    assert.equal(JSON.parse(readFileSync(path.join(out, 'pending.json'), 'utf8')).generation, generation);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
    assert.equal(lockHeld(out), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('the 20-round cap hands remaining work to a successor', async () => {
  const { root, out } = await project();
  try {
    queue(out, 'cap-initial');
    let builds = 0;
    let handedOff = false;
    const build = async (args) => { builds++; await buildMap(args); };
    const first = await runWorker({ root, out, debounceMs: 0, wait: async () => {}, build,
      hooks: {
        afterBuild: async () => { if (builds <= 20) assert.equal(await scheduleRebuild({ root, out, bin: BIN }), 'running'); },
        onHandoff: async () => {
          handedOff = true;
          assert.ok(existsSync(path.join(out, 'pending.json')), 'uncapped work remains queued for the successor');
          assert.equal(await runWorker({ root, out, debounceMs: 0, wait: async () => {}, build }), 'done');
        },
      },
    });
    assert.equal(first, 'done');
    assert.equal(handedOff, true);
    assert.equal(builds, 21);
    assert.equal(existsSync(path.join(out, 'pending.json')), false);
    assert.equal(readdirSync(out).some((name) => name.startsWith('pending.claim.')), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('`touch` as a real process: valid output or silence, always exit 0, even on garbage input', async () => {
  const { root, out } = await project();
  let primaryError;
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
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanup(root, out, primaryError); }
});
