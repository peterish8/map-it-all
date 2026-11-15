// init writes the instruction block to the END of CLAUDE.md and AGENTS.md, idempotently; uninstall undoes it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCK_END, BLOCK_START, applyBlock, blockText, removeBlock } from '../src/init.mjs';
import { fixture, write } from './fixtures.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd });
const read = (root, f) => readFileSync(path.join(root, f), 'utf8');

test('applyBlock appends at the very end, updates in place, keeps line endings, and removeBlock is clean', () => {
  const root = fixture();
  try {
    const f = path.join(root, 'NOTES.md');
    write(root, 'NOTES.md', '# Notes\r\n\r\nExisting text.\r\n\r\n');
    assert.equal(applyBlock(f, blockText()), 'appended');
    let text = readFileSync(f, 'utf8');
    assert.ok(text.startsWith('# Notes\r\n\r\nExisting text.\r\n\r\n<!-- map-it-all:start -->'), 'one blank line, then the block');
    assert.ok(text.endsWith(`${BLOCK_END}\r\n`), 'the block is the very last thing, with a single trailing newline');
    assert.ok(!/[^\r]\n/.test(text), 'CRLF file stays CRLF everywhere');
    assert.equal(applyBlock(f, blockText()), 'unchanged', 'a second run changes nothing');
    assert.equal(applyBlock(f, blockText('custom-dir')), 'updated', 'an edited block is replaced in place');
    text = readFileSync(f, 'utf8');
    assert.equal(text.split(BLOCK_START).length, 2, 'never duplicated');
    assert.match(text, /custom-dir/);
    assert.equal(removeBlock(f), 'removed');
    assert.equal(readFileSync(f, 'utf8'), '# Notes\r\n\r\nExisting text.\r\n', 'removal restores the original text');
    // a file that only held our block disappears with it
    const solo = path.join(root, 'SOLO.md');
    assert.equal(applyBlock(solo, blockText()), 'created');
    assert.equal(removeBlock(solo), 'deleted');
    assert.equal(existsSync(solo), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init does everything in one command and is idempotent', () => {
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', '# My project rules\n\n- Be nice.\n');
    const first = run(['init', '--npx'], root);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\[1\/4\] Map\s+built/);
    assert.match(first.stdout, /connections: \d+ import edges/);
    assert.match(first.stdout, /CLAUDE\.md: appended; AGENTS\.md: created/);
    assert.ok(existsSync(path.join(root, '.map-it-all', 'stamp.json')), 'the map was generated');
    assert.ok(JSON.parse(read(root, '.mcp.json')).mcpServers['map-it-all'], 'MCP config written');
    assert.match(read(root, '.gitignore'), /\.map-it-all\//);
    const claude = read(root, 'CLAUDE.md');
    assert.ok(claude.startsWith('# My project rules\n\n- Be nice.\n\n<!-- map-it-all:start -->'), 'existing content untouched, block at the end');
    assert.ok(claude.trimEnd().endsWith(BLOCK_END));
    assert.match(read(root, 'AGENTS.md'), /`brief` tool/);

    const again = run(['init', '--npx'], root);
    assert.match(again.stdout, /CLAUDE\.md: unchanged; AGENTS\.md: unchanged/);
    assert.equal(read(root, 'CLAUDE.md').split(BLOCK_START).length, 2, 'still exactly one block');

    const dry = run(['init', '--npx', '--dry-run'], root);
    assert.match(dry.stdout, /dry run/);
    assert.match(dry.stdout, /would update the block/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init writes a shared CLAUDE.md/AGENTS.md only once, and respects --no-docs and --docs', () => {
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', '# Rules\n');
    try { symlinkSync(path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md')); } catch { return; } // symlinks may need privileges on Windows
    const r = run(['init', '--npx', '--no-build'], root);
    assert.match(r.stdout, /AGENTS\.md: same file as CLAUDE\.md/);
    assert.equal(read(root, 'CLAUDE.md').split(BLOCK_START).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const other = fixture();
  try {
    assert.match(run(['init', '--npx', '--no-build', '--no-docs'], other).stdout, /Instructions\s+skipped/);
    assert.ok(!read(other, 'CLAUDE.md').includes(BLOCK_START), 'the fixture’s own CLAUDE.md is left alone');
    assert.equal(existsSync(path.join(other, 'AGENTS.md')), false);
    run(['init', '--npx', '--no-build', '--docs', 'agents'], other);
    assert.ok(!read(other, 'CLAUDE.md').includes(BLOCK_START));
    assert.ok(read(other, 'AGENTS.md').includes(BLOCK_START));
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('init --hook installs both hooks and turns realtime on; uninstall removes everything it added', () => {
  const root = fixture();
  try {
    write(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    run(['init', '--npx', '--no-build', '--hook'], root);
    const s = JSON.parse(read(root, '.claude/settings.json'));
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'other settings untouched');
    assert.ok(s.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === 'echo mine')), 'your own hook is kept');
    const touch = s.hooks.PostToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit');
    assert.match(touch.hooks[0].command, /map-it-all\.mjs" touch$/);
    assert.equal(touch.hooks[0].timeout, 10, 'a short timeout: the hook must never stall an edit');
    assert.match(s.hooks.SessionStart[0].hooks[0].command, /session-start/);
    assert.match(run(['realtime'], root).stdout, /realtime: ON/);

    run(['init', '--npx', '--no-build', '--hook'], root);
    assert.equal(JSON.parse(read(root, '.claude/settings.json')).hooks.PostToolUse.length, 2, 'no duplicate hooks on re-run');

    const gone = run(['uninstall'], root);
    assert.match(gone.stdout, /map-it-all hooks: removed/);
    const after = JSON.parse(read(root, '.claude/settings.json'));
    assert.deepEqual(after.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }]);
    assert.equal(after.hooks.SessionStart, undefined);
    assert.equal(existsSync(path.join(root, '.mcp.json')), false, 'the MCP entry (and the now-empty file) are removed');
    assert.ok(existsSync(path.join(root, '.map-it-all')), 'memory and handoff are kept without --purge');
    run(['uninstall', '--purge'], root);
    assert.equal(existsSync(path.join(root, '.map-it-all')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uninstall --purge refuses to delete outside the project', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'map-it-all.config.json'), JSON.stringify({ out: '..' }));
    const r = run(['uninstall', '--purge'], root);
    assert.match(r.stdout, /NOT deleted/);
    assert.ok(existsSync(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init stays offline by default; init --online writes the network opt-in, keeps other config, and --dry-run does not', () => {
  const root = fixture();
  try {
    write(root, 'map-it-all.config.json', JSON.stringify({ historyDirs: ['old'] }));
    const plain = run(['init', '--npx', '--no-build'], root);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(read(root, 'map-it-all.config.json')).network, undefined, 'ordinary init never enables the network');

    const dry = run(['init', '--npx', '--no-build', '--online', '--dry-run'], root);
    assert.match(dry.stdout, /would set "network": true/);
    assert.equal(JSON.parse(read(root, 'map-it-all.config.json')).network, undefined);

    const on = run(['init', '--npx', '--no-build', '--online'], root);
    assert.match(on.stdout, /Network\s+set/);
    assert.deepEqual(JSON.parse(read(root, 'map-it-all.config.json')), { historyDirs: ['old'], network: true });
    assert.match(run(['init', '--npx', '--no-build', '--online'], root).stdout, /Network\s+already set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
