// The runner behind `npm test` builds the file list itself: Node 20 does not expand glob patterns given
// to `node --test`, and Windows shells never do. It must run every top-level test file, skip helpers and
// test/live, and fail loudly when it finds nothing (a silent zero-file run would look like a pass).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-tests.mjs');
const passing = (name) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
// Node refuses a nested `node --test` while NODE_TEST_CONTEXT (set by the outer run) is present.
const cleanEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-it-all-runner-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
}

test('the runner runs each top-level *.test.mjs file and nothing else', () => withDir((dir) => {
  writeFileSync(path.join(dir, 'a.test.mjs'), passing('a'));
  writeFileSync(path.join(dir, 'b.test.mjs'), passing('b'));
  writeFileSync(path.join(dir, 'helper.mjs'), 'export const helper = 1;\n');
  mkdirSync(path.join(dir, 'live'));
  // Would fail if it ran: proves nested folders (test/live) are not matched.
  writeFileSync(path.join(dir, 'live', 'c.test.mjs'), "import { test } from 'node:test';\ntest('live', () => { throw new Error('live must not run'); });\n");
  const r = spawnSync(process.execPath, [RUNNER, dir], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /running 2 test files/);
  assert.match(r.stdout + r.stderr, /(?:# |ℹ )pass 2\b/);
}));

test('the runner fails loudly when there are no test files', () => withDir((dir) => {
  const r = spawnSync(process.execPath, [RUNNER, dir], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no test files/);
}));
