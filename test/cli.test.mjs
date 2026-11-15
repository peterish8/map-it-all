import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'map-it-all.mjs');
const run = (args, options = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

test('--version, -v and help', () => {
  assert.equal(run(['--version']).stdout.trim(), VERSION);
  assert.equal(run(['-v']).stdout.trim(), VERSION);
  const help = run([]).stdout;
  for (const cmd of ['demo', 'init', 'doctor', 'build', 'view', 'brief', 'query', 'diff', 'check', 'session-start', 'memory', 'handoff', 'tokens', 'mcp']) {
    assert.ok(help.includes(`  ${cmd}`), `help lists ${cmd}`);
  }
  assert.match(run(['build', '--help']).stdout, /^map-it-all build/);
  assert.equal(run(['nope']).status, 2, 'unknown command exits 2');
});

test('demo maps the bundled project into the temp folder and finds the planted problems', () => {
  const r = run(['demo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Session brief: demo-app/);
  assert.match(r.stdout, /convex: 9 functions/);
  assert.match(r.stdout, /express: 11 routes \(2 conditional\)/);
  assert.match(r.stdout, /Docs pointing at missing paths: 1 doc/);
  assert.doesNotMatch(r.stdout, /uncommitted/, 'the demo never reports the parent repo’s git state');
  assert.match(r.stdout, /graph\.html/);
});

test('file, connections, leads and symbol work from the terminal and match the MCP tools', () => {
  const out = path.join(ROOT, '.map-it-all-cli-test');
  const common = ['--root', path.join(ROOT, 'examples', 'demo-app'), '--out', out];
  try {
    const leads = run(['leads', ...common]).stdout;
    assert.match(leads, /convex:habits\.archive.*\[no-refs\] public/);
    assert.match(leads, /native-module:HabitWidget.*not-in-ExpoModulesPackageList/);
    const rec = run(['connections', 'convex:habits.archive', ...common]).stdout;
    assert.match(rec, /No by-name callers recorded for convex:habits\.archive.*public/s);
    const blast = run(['connections', 'web/src/lib/api.ts', '--direction', 'in', ...common]).stdout;
    assert.match(blast, /web\/src\/hooks\/useHabits\.ts/);
    assert.match(run(['connections', 'web/src/lib/api.ts', '--mermaid', ...common]).stdout, /^graph LR/);
    assert.match(run(['file', 'server/routes/legacy.ts', ...common]).stdout, /unmounted/);
    assert.match(run(['symbol', 'formatDays', ...common]).stdout, /declared web\/src\/lib\/format\.ts/);
    assert.equal(run(['connections', ...common]).status, 2, 'a missing target is a usage error');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('init --npx prints an npx entry; without it, a path to this clone; --write merges and keeps other servers', () => {
  const root = fixture();
  try {
    const npx = run(['init', '--agent', 'claude', '--npx', '--root', root]).stdout;
    assert.match(npx, /github:peterish8\/map-it-all/);
    assert.match(npx, process.platform === 'win32' ? /"cmd"/ : /"npx"/);
    const local = run(['init', '--agent', 'cursor', '--root', root]).stdout;
    assert.match(local, /map-it-all\.mjs/);
    const wrote = run(['init', '--agent', 'vscode', '--write', '--root', root]);
    assert.match(wrote.stdout, /wrote \.vscode[\\/]mcp\.json/);
    const json = JSON.parse(readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
    assert.ok(json.servers['map-it-all']);
    assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.map-it-all\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project root comes from --root, then MAP_IT_ALL_ROOT, then the working directory', () => {
  const root = fixture();
  try {
    const viaEnv = run(['build'], { env: { ...process.env, MAP_IT_ALL_ROOT: root }, cwd: ROOT });
    assert.match(viaEnv.stdout, new RegExp(path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const viaCwd = run(['build'], { cwd: root });
    assert.match(viaCwd.stdout, /packs: convex, express, expo/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
