// The git runner for evidence packets and reviews. Refs are validated before they reach git, and every
// ref goes into argv after `--end-of-options`, so a ref can never be read as a flag. No shell is used.
// `context.mjs` git() is the map's own runner and is not changed; this one adds the flags the packets need.

import { spawnSync } from 'node:child_process';

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * A ref as the user typed it: a branch, tag or commit SHA. Returns the input unchanged or throws
 * `{ code: 'invalid_ref' }`. Rejected: leading "-", "..", whitespace, control characters, peel and reflog
 * syntax, and characters that a shell or git would read as more than a name.
 */
export function validateRef(text) {
  const reject = (why) => { throw fail('invalid_ref', `invalid ref ${JSON.stringify(String(text))}: ${why}; use a branch, tag or commit SHA`); };
  if (typeof text !== 'string' || text.length === 0) reject('it is empty');
  if (text.length > 255) reject('it is longer than 255 characters');
  if (text.startsWith('-')) reject('it starts with "-" and would be read as a flag');
  if (/[\s\x00-\x1f\x7f]/.test(text)) reject('it contains whitespace or control characters');
  if (text.includes('..')) reject('it contains ".."');
  if (text.includes('^{') || text.includes('@{')) reject('it uses peel or reflog syntax');
  if (/[:;|&$`"'<>()*?[\]\\~^]/.test(text)) reject('it contains a character that is not allowed in a ref');
  return text;
}

/** Runs git with argv only and the flags packets need (no quoted paths, no external or text-conversion diff). */
export function git(root, args) {
  return spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'diff.external=', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
}

/** The commit a ref names. Unknown refs throw `{ code: 'unknown_ref' }`. */
export function resolveCommit(root, ref) {
  validateRef(ref);
  const r = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = r.status === 0 ? r.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw fail('unknown_ref', `unknown ref "${ref}": no such branch, tag or commit`);
  return sha;
}

/** The merge base of two resolved commits. No common ancestor (or a shallow clone without it) throws `merge_base_unavailable`. */
export function mergeBase(root, a, b) {
  const r = git(root, ['merge-base', '--end-of-options', a, b]);
  const sha = r.status === 0 ? r.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw fail('merge_base_unavailable', 'no merge base between the two commits; in a shallow clone, fetch more history (git fetch --deepen=100)');
  return sha;
}
