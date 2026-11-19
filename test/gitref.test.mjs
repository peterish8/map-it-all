// Ref validation before any git call (CTX-01 T7, REV-01). Refs reach git only as argv after this check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCommit, validateRef } from '../src/gitref.mjs';
import { gitFixture, removeFixture } from './fixtures.mjs';

test('validateRef accepts branch names, full refs and commit SHAs unchanged', () => {
  for (const ref of ['main', 'refs/heads/main', 'feature/review-2', 'a'.repeat(40)]) {
    assert.equal(validateRef(ref), ref, `accepts ${ref}`);
  }
});

test('validateRef rejects flags, ranges, peel syntax, reflogs, spaces and shell metacharacters as invalid_ref', () => {
  const rejected = ['-x', '--output=/tmp/x', 'a..b', 'HEAD^{}', 'main@{1}', 'main:path', 'with space', ' main', 'main\n', 'main;rm', '$(x)', 'a|b', 'a`b`', 'a"b', "a'b", 'a<b', 'x'.repeat(300), ''];
  for (const ref of rejected) {
    assert.throws(
      () => validateRef(ref),
      (error) => error.code === 'invalid_ref' && /use a branch, tag or commit SHA/.test(error.message),
      `rejects ${JSON.stringify(ref)}`,
    );
  }
});

test('resolveCommit returns the commit for a known ref and reports an unknown ref as unknown_ref', () => {
  const root = gitFixture({ files: { 'a.txt': 'a\n' } });
  try {
    assert.match(resolveCommit(root, 'main'), /^[0-9a-f]{40}$/);
    assert.throws(() => resolveCommit(root, 'no-such-branch'), (error) => error.code === 'unknown_ref');
  } finally {
    removeFixture(root);
  }
});
