import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireBuildLock, releaseBuildLock, withBuildLock } from '../src/build-lock.mjs';

test('operation errors stay primary when release callbacks fail and local waiters are released', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'map-it-all-lock-'));
  const operationError = new Error('build operation failed');
  const cleanupError = new Error('handoff callback failed');
  try {
    await assert.rejects(withBuildLock(out, async () => { throw operationError; }, undefined, async () => { throw cleanupError; }), (error) => {
      assert.equal(error, operationError);
      assert.deepEqual(error.cleanupErrors, [cleanupError]);
      return true;
    });
    const handle = await acquireBuildLock(out, { wait: false });
    assert.ok(handle, 'cleanup releases the process-local queue even when the callback fails');
    assert.equal(await releaseBuildLock(handle), true);

    const successCleanupError = new Error('cleanup only');
    await assert.rejects(withBuildLock(out, async () => 'ok', undefined, async () => { throw successCleanupError; }), (error) => error === successCleanupError);
    const after = await acquireBuildLock(out, { wait: false });
    assert.ok(after, 'a successful operation with failed cleanup still releases lock ownership');
    await releaseBuildLock(after);

    const broken = await acquireBuildLock(out);
    const unlockError = new Error('unlock failed');
    const closeError = new Error('close reported failure');
    let handedOff = false;
    broken.unlock = async () => { throw unlockError; };
    broken.close = (fd) => { closeSync(fd); throw closeError; };
    broken.afterRelease.push(() => { handedOff = true; });
    await assert.rejects(releaseBuildLock(broken), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [unlockError, closeError]);
      return true;
    });
    assert.equal(broken.ownershipReleased, false, 'a throwing close leaves release status uncertain');
    assert.equal(handedOff, false, 'uncertain ownership never triggers a post-release handoff');
    const afterUncertain = await acquireBuildLock(out, { wait: false });
    assert.ok(afterUncertain, 'the local queue releases even after unlock and close failures');
    await releaseBuildLock(afterUncertain);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
