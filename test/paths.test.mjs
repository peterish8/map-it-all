// Path containment for paths that come from agents, PR text or the working tree.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PathError, isInside, resolveInside } from '../src/paths.mjs';

function withRoots(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-paths-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'map-it-all-paths-outside-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(outside, 'secret.ts'), 'export const SECRET = 1;\n');
    return fn(root, outside);
  } finally {
    for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

const REJECTED = [
  ['../x', 'escapes the project folder'],
  ['a/../../x', 'escapes the project folder'],
  ['..', 'escapes the project folder'],
  ['a\\..\\..\\x', 'escapes the project folder'],
  ['/etc/passwd', 'is absolute'],
  ['\\etc\\passwd', 'is absolute'],
  ['C:\\Windows\\win.ini', 'has a drive letter'],
  ['C:foo', 'has a drive letter'],
  ['\\\\server\\share\\x', 'is a UNC or device path'],
  ['\\\\?\\C:\\x', 'is a UNC or device path'],
  ['//server/share/x', 'is a UNC or device path'],
  ['file.txt:secret', 'contains ":"'],
  ['a\u0000b', 'contains a NUL byte'],
  ['', 'is empty'],
];

for (const [input, reason] of REJECTED) {
  test(`rejects ${JSON.stringify(input)}: ${reason}`, () => withRoots((root) => {
    assert.throws(() => resolveInside(root, input), (error) => error instanceof PathError && error.message.includes(reason), `expected "${reason}"`);
  }));
}

test('accepts plain relative paths, with either separator, and resolves them under the root', () => withRoots((root) => {
  assert.equal(resolveInside(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(resolveInside(root, 'src\\a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(resolveInside(root, 'src/../src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(resolveInside(root, 'missing/new.ts'), path.join(root, 'missing', 'new.ts'), 'missing files are allowed by default');
  assert.throws(() => resolveInside(root, 'missing/new.ts', { allowMissing: false }), /does not exist/);
}));

test('isInside compares paths lexically and does not mistake "..name" for a parent', () => withRoots((root) => {
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, 'src')), true);
  assert.equal(isInside(root, path.join(root, '..notes')), true, '"..notes" is a child of the root, not a parent');
  assert.equal(isInside(root, path.dirname(root)), false);
}));

test('links and junctions inside the project are fine; ones that resolve outside are refused', (t) => withRoots((root, outside) => {
  try {
    // A directory junction works without admin rights on Windows; on POSIX it is a plain symlink.
    symlinkSync(outside, path.join(root, 'linked-dir'), 'junction');
    symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked-file.ts'), 'file');
    symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'inside-link.ts'), 'file');
  } catch (error) {
    t.skip(`cannot create links here (${error.code}); needs developer mode or admin for file symlinks on Windows`);
    return;
  }
  assert.throws(() => resolveInside(root, 'linked-dir/secret.ts'), (e) => e instanceof PathError && /resolves outside the project folder/.test(e.message));
  assert.throws(() => resolveInside(root, 'linked-dir/missing.ts'), (e) => e instanceof PathError && /resolves outside/.test(e.message), 'a missing file under an outside junction is refused too');
  assert.throws(() => resolveInside(root, 'linked-file.ts'), (e) => e instanceof PathError && /resolves outside/.test(e.message));
  assert.equal(resolveInside(root, 'inside-link.ts'), path.join(root, 'inside-link.ts'), 'a link that stays inside is allowed');
}));
