import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildMap, check, diff, snapshot } from '../src/build.mjs';
import { parseJsonc } from '../src/imports.mjs';
import { byId, fixture, readRecords, write } from './fixtures.mjs';

async function withMap(fn) {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  try { return await fn(root, out, await buildMap({ root, out })); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('parseJsonc reads tsconfig-style files', () => {
  assert.deepEqual(parseJsonc('{ /* c */ "a": "//not a comment", // trailing\n "b": [1,], }'), { a: '//not a comment', b: [1] });
});

test('detects packs and resolves aliases and workspace packages', () => withMap(async (root, out, { stamp }) => {
  assert.deepEqual(Object.keys(stamp.packs).sort(), ['convex', 'expo', 'express']);
  assert.deepEqual(stamp.errors.filter((e) => !e.soft), []);
  assert.deepEqual(check(stamp), [], 'parity between ast-grep and plain regexes holds');
  assert.ok(stamp.resolver.aliases >= 1 && stamp.resolver.workspaces >= 1);

  const imports = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(path.join(out, 'imports.json'), 'utf8'))).index;
  assert.ok(imports['packages/shared/a.ts']?.some((e) => e.startsWith('web/call.ts')), '@shared/* alias from tsconfig paths');
  assert.ok(imports['packages/shared/src/index.ts']?.some((e) => e.startsWith('web/call.ts')), 'workspace package name resolves to its entry');
  assert.equal(imports['packages/shared/unused.ts'], undefined);
}));

test('convex pack: callers, wrappers, crons, tables; history is ignored', () => withMap((root, out) => {
  const convex = readRecords(out, 'convex');
  assert.ok(byId(convex, 'convex:lib.dead').flags.includes('no-refs'), 'only history calls it, so it is unreferenced');
  assert.equal(byId(convex, 'convex:lib.used').prodRefCount, 1);
  assert.equal(byId(convex, 'convex:lib.sweep').refs[0].how, 'cron');
  assert.equal(byId(convex, 'convex:lib.sweep').public, false);
  assert.deepEqual(byId(convex, 'convex:lib.viaWrapper').flags, [], 'wrapper template plus string literal links the function');
  assert.ok(byId(convex, 'convex-table:ghosts').flags.includes('never-written-here'));
  assert.ok(byId(convex, 'convex-table:things').refs.some((r) => r.how === 'read'));
}));

test('express pack: flat, conditional, default-export, nested and same-file routers', () => withMap((root, out) => {
  const express = readRecords(out, 'express');
  const names = express.map((r) => r.name).sort();
  assert.deepEqual(names, [
    'GET /admin/stats', 'GET /api/bar', 'GET /api/foo/:id', 'GET /def/d', 'GET /health', 'GET /lost', 'GET /v2/deep/x', 'GET /v2/top', 'POST /api/never-called',
  ], 'history routes are ignored and every mount composes its prefix');
  assert.equal(byId(express, 'express:GET /api/foo/:p').prodRefCount, 1, 'template literal with a call inside matches the route');
  assert.ok(!byId(express, 'express:GET /api/foo/:p').flags.includes('undocumented'));
  assert.ok(byId(express, 'express:POST /api/never-called').flags.includes('no-refs'));
  assert.ok(byId(express, 'express:GET /api/bar').flags.includes('conditional-mount'));
  assert.ok(byId(express, 'express:GET /lost').flags.includes('unmounted'), 'a router nobody mounts is flagged');
  assert.equal(byId(express, 'express:GET /api/bar').mount.condition, 'process.env.EXTRA');
}));

test('expo pack: native modules, screens, kotlin classes', () => withMap((root, out) => {
  const mobile = readRecords(out, 'expo');
  const foo = byId(mobile, 'native-module:Foo');
  assert.equal(foo.kotlinClass, 'FooModule');
  assert.ok(foo.flags.includes('not-in-ExpoModulesPackageList'), 'Kotlin module missing from the package list');
  assert.equal(foo.prodRefCount, 1, 'JS requireNativeModule reaches it by name');
  assert.ok(byId(mobile, 'mobile-screen:HomeScreen').registered);
  assert.ok(byId(mobile, 'mobile-screen:LostScreen').flags.includes('no-refs'));
  assert.ok(byId(mobile, 'kotlin:apps/mobile/android/app/src/main/java/app/FooModule.kt#Helper').flags.includes('no-refs'));
}));

test('tooling and docs drift', () => withMap((root, out) => {
  const tooling = readRecords(out, 'tooling');
  assert.ok(byId(tooling, 'npm-script:package.json#orphan-script').flags.includes('no-refs'));
  assert.ok(!byId(tooling, 'npm-script:package.json#test').flags.includes('no-refs'), 'lifecycle names are entries');
  const drift = readRecords(out, 'drift');
  const claude = byId(drift, 'doc-drift:CLAUDE.md');
  assert.deepEqual(claude.dead.map((d) => d.ref), ['server/gone.ts'], 'missing file flagged; existing file and fenced example are not');
}));

test('driftIgnore silences references to files that live in someone else\'s project', async () => {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  try {
    write(root, 'map-it-all.config.json', JSON.stringify({ driftIgnore: ['^server/gone'] }));
    await buildMap({ root, out });
    assert.equal(byId(readRecords(out, 'drift'), 'doc-drift:CLAUDE.md'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a broken ast-grep never produces a brief that looks complete', async () => {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  const before = process.env.AST_GREP_BIN;
  process.env.AST_GREP_BIN = path.join(root, 'does-not-exist');
  try {
    const { stamp } = await buildMap({ root, out });
    assert.ok(stamp.errors.some((e) => !e.soft && e.extractor === 'express'), 'the failure is recorded');
    assert.notDeepEqual(check(stamp), [], 'check fails');
    const { renderBrief } = await import('../src/brief.mjs');
    const { loadStore } = await import('../src/store.mjs');
    const { createMemory } = await import('../src/memory.mjs');
    const text = renderBrief({ root, store: loadStore(out), memory: createMemory({ root, dir: path.join(out, 'memory') }), files: [] });
    assert.match(text, /MAP INCOMPLETE/);
    assert.match(text, /Do not trust absences/);
  } finally {
    if (before === undefined) delete process.env.AST_GREP_BIN; else process.env.AST_GREP_BIN = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff reports what a session newly orphaned', async () => {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  try {
    await buildMap({ root, out });
    snapshot(out);
    rmSync(path.join(root, 'web', 'call.ts'));
    await buildMap({ root, out });
    const report = diff(out);
    assert.match(report, /Newly orphaned[^\n]*: 1/);
    assert.match(report, /convex:lib\.used/);
    assert.match(report, /VERIFY, not REMOVE/, 'public surface is never presented as removable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the scanner never reads through a link or junction that resolves outside the project', async (t) => {
  const root = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'map-it-all-scan-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.ts'), "import { idx } from '@fx/shared';\nexport const SECRET_MARKER = 1;\n");
    // Git must list these paths for the scanner to see them, so the fixture is a real repository.
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0, 'git init');
    try {
      // A directory junction needs no admin rights on Windows; on POSIX it is a symlink.
      symlinkSync(outside, path.join(root, 'linked'), 'junction');
      symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked-file.ts'), 'file');
    } catch (error) {
      t.skip(`cannot create links here (${error.code})`);
      return;
    }
    const out = path.join(root, '.map-it-all');
    const built = await buildMap({ root, out });
    const files = JSON.parse(readFileSync(path.join(out, 'files.json'), 'utf8')).files;
    assert.ok(!files.includes('linked/secret.ts'), 'a file behind an outside junction is not scanned');
    assert.ok(!files.includes('linked-file.ts'), 'an outside file symlink is not scanned');
    // The soft note names the skipped paths on purpose; the content and any import edge it would create must not appear.
    for (const name of readdirSync(out)) {
      assert.doesNotMatch(readFileSync(path.join(out, name), 'utf8'), /SECRET_MARKER/, `${name} carries no outside content`);
    }
    assert.doesNotMatch(readFileSync(path.join(out, 'imports.json'), 'utf8'), /"linked\//, 'no import edge comes from a skipped file');
    const note = built.stamp.errors.find((e) => e.soft && /resolves outside the project/.test(e.message));
    assert.ok(note, `a soft note says what was skipped: ${JSON.stringify(built.stamp.errors)}`);
    assert.match(note.message, /2 file\(s\) skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
