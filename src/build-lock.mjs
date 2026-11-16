import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { constants, flock, lockFileEx, unlockFileEx } from 'fs-ext-extra-prebuilt';

const windows = process.platform === 'win32';
const lockRange = { offsetLow: 0, offsetHigh: 0, lengthLow: 1, lengthHigh: 0 };

function lockFile(fd, wait) {
  return new Promise((resolve, reject) => {
    const done = (error) => error ? reject(error) : resolve();
    try {
      if (windows) {
        let flags = constants.LOCKFILE_EXCLUSIVE_LOCK;
        if (!wait) flags |= constants.LOCKFILE_FAIL_IMMEDIATELY;
        lockFileEx(fd, flags, lockRange.offsetLow, lockRange.offsetHigh, lockRange.lengthLow, lockRange.lengthHigh, done);
      } else {
        flock(fd, wait ? 'ex' : 'exnb', done);
      }
    } catch (error) { reject(error); }
  });
}

function unlockFile(fd) {
  return new Promise((resolve, reject) => {
    const done = (error) => error ? reject(error) : resolve();
    try {
      if (windows) unlockFileEx(fd, lockRange.offsetLow, lockRange.offsetHigh, lockRange.lengthLow, lockRange.lengthHigh, done);
      else flock(fd, 'un', done);
    } catch (error) { reject(error); }
  });
}

// Kernel locks are per open handle on both platforms. Serialize descriptors for
// the same lock within this process too, including probes and closes.
const local = new Map();
const ownedHandles = new WeakSet();
const lockPath = (out, name) => path.join(path.resolve(out), name);

async function acquireLocal(key, wait) {
  const previous = local.get(key);
  if (previous && !wait) return null;
  let unlock;
  const current = new Promise((resolve) => { unlock = resolve; });
  const tail = previous ? previous.then(() => current) : current;
  local.set(key, tail);
  if (previous) await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (local.get(key) === tail) local.delete(key);
  };
}

export async function acquireNamedLock(out, name, { wait = true } = {}) {
  out = path.resolve(out);
  mkdirSync(out, { recursive: true });
  out = realpathSync(out);
  const file = lockPath(out, name);
  const releaseLocal = await acquireLocal(file, wait);
  if (!releaseLocal) return null;
  let fd;
  try {
    fd = openSync(file, 'a+');
    await lockFile(fd, wait);
    const handle = { out, file, fd, released: false, releaseLocal, afterRelease: [], unlock: unlockFile, close: closeSync };
    ownedHandles.add(handle);
    return handle;
  } catch (error) {
    const cleanup = [];
    if (fd !== undefined) {
      try { closeSync(fd); } catch (e) { cleanup.push(e); }
    }
    releaseLocal();
    if (!wait && ['EACCES', 'EAGAIN', 'EWOULDBLOCK', 'EBUSY'].includes(error.code)) return null;
    if (cleanup.length) Object.defineProperty(error, 'cleanupErrors', { value: cleanup, configurable: true });
    throw error;
  }
}

export const acquireBuildLock = (out, options) => acquireNamedLock(out, 'build.lock', options);

export async function releaseBuildLock(handle) {
  if (!handle || !ownedHandles.has(handle) || handle.released) return false;
  ownedHandles.delete(handle);
  handle.released = true;
  const errors = [];
  let released = false;
  try { await handle.unlock(handle.fd); released = true; } catch (error) { errors.push(error); }
  try { handle.close(handle.fd); released = true; } catch (error) { errors.push(error); }
  try { handle.releaseLocal(); } catch (error) { errors.push(error); }
  handle.ownershipReleased = released;
  // A successful close releases the descriptor's lock even if explicit unlock failed.
  if (released) {
    for (const callback of handle.afterRelease ?? []) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Lock cleanup failed');
  return true;
}

export function lockHeld(out) {
  try { out = realpathSync(path.resolve(out)); } catch { out = path.resolve(out); }
  return local.has(lockPath(out, 'build.lock'));
}

export function namedLockHeld(out, name) {
  try { out = realpathSync(path.resolve(out)); } catch { out = path.resolve(out); }
  return local.has(lockPath(out, name));
}

/** Immediate cross-process probe. Never open a second descriptor when owned locally. */
export async function buildLockHeld(out) {
  if (lockHeld(out)) return true;
  if (!existsSync(lockPath(out, 'build.lock'))) return false;
  const probe = await acquireBuildLock(out, { wait: false });
  if (!probe) return true;
  await releaseBuildLock(probe);
  return false;
}

export function addAfterRelease(handle, callback) {
  if (handle && ownedHandles.has(handle) && !handle.released && callback) handle.afterRelease.push(callback);
}

export async function withBuildLock(out, fn, existing, afterRelease) {
  const resolved = path.resolve(out);
  mkdirSync(resolved, { recursive: true });
  const canonical = realpathSync(resolved);
  if (existing && ownedHandles.has(existing) && !existing.released && existing.out === canonical) {
    addAfterRelease(existing, afterRelease);
    return fn();
  }
  const handle = await acquireBuildLock(canonical);
  addAfterRelease(handle, afterRelease);
  let result;
  let operationError;
  try { result = await fn(); } catch (error) { operationError = error; }
  let cleanupError;
  try { await releaseBuildLock(handle); } catch (error) { cleanupError = error; }
  if (operationError && cleanupError) {
    Object.defineProperty(operationError, 'cleanupErrors', { value: [cleanupError], configurable: true });
    throw operationError;
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

export async function waitForBuildLock(out, maxMs = 30000) {
  const handle = await acquireBuildLock(out, { wait: false });
  if (!handle) {
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const probe = await acquireBuildLock(out, { wait: false });
      if (probe) { await releaseBuildLock(probe); return true; }
    }
    return false;
  }
  await releaseBuildLock(handle);
  return true;
}
