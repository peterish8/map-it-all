#!/usr/bin/env node
// Runs every top-level test file (test/*.test.mjs) with node:test. The file list is built here, not by the
// shell: Node 20 does not expand glob patterns given to `node --test` (Node 21+ does), and Windows shells
// never do. Helpers and test/live (opt-in, never part of npm test) are not matched.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(ROOT, process.argv[2] ?? 'test');
const files = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => path.join(dir, entry.name))
  .sort();

if (!files.length) {
  console.error(`no test files found in ${dir}`);
  process.exit(1);
}
console.log(`running ${files.length} test files from ${path.relative(ROOT, dir) || '.'}`);
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
