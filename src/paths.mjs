// Path containment for paths that come from agents, PR text or the working tree.
//
// resolveInside(root, rel) returns the absolute path of `rel` under `root`, or throws a PathError that says why
// it may not be used. The text checks run first and are the same on every OS: no absolute, drive, UNC or device
// paths, no colon (NTFS streams and line suffixes are not paths), no NUL bytes, and no `..` that escapes after
// normalising. Then the real location of the longest existing prefix is compared with the real root, so a
// symlink or Windows junction inside the project cannot lead outside it.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class PathError extends Error {
  constructor(input, reason) {
    super(`"${String(input).replaceAll('\0', '\\0')}" ${reason}`);
    this.name = 'PathError';
    this.input = input;
    this.reason = reason;
  }
}

const DRIVE = /^[A-Za-z]:/;

/** Lexical check: is `abs` `root` or somewhere below it? (Does not look at the disk.) */
export function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real location of `abs`: the longest existing prefix resolved (links and junctions), the rest re-appended. */
function realLocation(abs) {
  const rest = [];
  let probe = abs;
  for (;;) {
    try {
      return path.join(realpathSync.native(probe), ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** The real path of the project root. Callers that check many paths compute it once. */
export const realRootOf = (root) => realpathSync.native(root);

/** Whether `abs`, with every link and junction on the way resolved, is inside `realRootPath` (from realRootOf). */
export function isRealInsideOf(realRootPath, abs) {
  return isInside(realRootPath, realLocation(abs));
}

/** Whether `abs`, with every link and junction on the way resolved, is still inside the project `root`. */
export function isRealInside(root, abs) {
  return isRealInsideOf(realRootOf(root), abs);
}

/**
 * Absolute path of `rel` under `root`. `allowMissing: false` also requires the path to exist.
 * Throws PathError (its `reason` says what was wrong) for anything that is not a plain path inside the project.
 */
export function resolveInside(root, rel, { allowMissing = true } = {}) {
  const fail = (reason) => { throw new PathError(rel, reason); };
  if (typeof rel !== 'string') fail('is not a string');
  if (rel.trim() === '') fail('is empty');
  if (rel.includes('\0')) fail('contains a NUL byte');
  if (/^[\\/]{2}/.test(rel)) fail('is a UNC or device path');
  if (/^[\\/]/.test(rel)) fail('is absolute');
  if (DRIVE.test(rel)) fail('has a drive letter');
  if (rel.includes(':')) fail('contains ":" (an NTFS stream or a line suffix, not part of a path)');
  const normal = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (normal === '..' || normal.startsWith('../')) fail('escapes the project folder');
  const abs = path.resolve(root, normal);
  if (!isInside(root, abs)) fail('escapes the project folder');
  if (!isRealInside(root, abs)) fail('resolves outside the project folder (through a symlink or junction)');
  if (!allowMissing && !existsSync(abs)) fail('does not exist');
  return abs;
}
