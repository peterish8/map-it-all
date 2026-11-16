import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const dry = run(['init', '--agent', 'claude', '--npx', '--dry-run', '--root', root]).stdout;
    assert.match(dry, /dry run/);
    assert.equal(existsSync(path.join(root, '.mcp.json')), false, 'a dry run writes nothing');
    run(['init', '--agent', 'claude', '--npx', '--root', root]);
    const claude = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers['map-it-all'];
    assert.match(JSON.stringify(claude), /github:peterish8\/map-it-all/);
    assert.equal(claude.command, process.platform === 'win32' ? 'cmd' : 'npx');
    run(['init', '--agent', 'vscode', '--root', root]);
    const json = JSON.parse(readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
    assert.match(JSON.stringify(json.servers['map-it-all']), /map-it-all\.mjs/, 'without --npx the entry points at this clone');
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

test('deps and docs run through the CLI offline and use the lockfile version', () => {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  try {
    const manifestPath = path.join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { lodash: '4.17.15' };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      name: manifest.name,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: manifest.name, dependencies: { lodash: '4.17.15' } },
        'node_modules/lodash': { version: '4.17.15' },
      },
    }));

    const common = ['--root', root, '--out', out];
    const deps = run(['deps', ...common]);
    assert.equal(deps.status, 0, deps.stderr);
    assert.match(deps.stdout, /Possibly unused production dependencies[^\n]*lodash/);
    assert.match(deps.stdout, /Network lookups are off/);

    const docs = run(['docs', 'lodash', 'debounce', ...common]);
    assert.equal(docs.status, 0, docs.stderr);
    assert.match(docs.stdout, /No saved docs for lodash@4\.17\.15/);
    assert.match(docs.stdout, /Network lookups are off/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
