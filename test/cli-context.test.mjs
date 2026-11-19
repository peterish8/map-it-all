// `map-it-all context` through the real binary (CTX-01, CTX-02): exit codes, JSON, expansion, zero writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitFixture, removeFixture, write } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'map-it-all.mjs');
const run = (root, args) => spawnSync(process.execPath, [BIN, ...args, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
const TASK = 'change formatOrder return shape in helpers, handler and route';

function seededRepo() {
  return gitFixture({
    files: {
      'src/helpers.mjs': 'export function formatOrder(items) { return { count: items.length, items }; }\n',
      'src/handler.mjs': "import { formatOrder } from './helpers.mjs';\nexport function handle(body) { return formatOrder(body.items).count; }\n",
      'src/route.mjs': "import { handle } from './handler.mjs';\nexport function route(req) {\n  return handle(req.body);\n}\n",
    },
  });
}

/** Every file under the project except the map's own folder and .git: name -> content. */
function treeOf(root, dir = root, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.map-it-all' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) treeOf(root, full, out);
    else if (statSync(full).isFile()) out.set(path.relative(root, full), readFileSync(full).toString('base64'));
  }
  return out;
}

test('context --json prints a packet with the seeded importer at depth 2 and exits 0', () => {
  const root = seededRepo();
  try {
    write(root, 'src/helpers.mjs', 'export function formatOrder(items) { return items.map((i) => i); }\n');
    const r = run(root, ['context', '--task', TASK, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const packet = JSON.parse(r.stdout);
    assert.equal(packet.kind, 'pratzystack.context');
    const route = packet.items.find((i) => i.kind === 'importer' && i.path === 'src/route.mjs');
    assert.equal(route?.depth, 2);
    assert.deepEqual(packet.usage, { modelCalls: 0 });
  } finally {
    removeFixture(root);
  }
});

test('context with no task exits 2 and prints the command help', () => {
  const root = seededRepo();
  try {
    const r = run(root, ['context']);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /map-it-all context/);
  } finally {
    removeFixture(root);
  }
});

test('--max-tokens outside 200..6000 exits 2 with the exact message; a valid value is honoured and never exceeded', () => {
  const root = seededRepo();
  try {
    const high = run(root, ['context', '--task', TASK, '--max-tokens', '6001']);
    assert.equal(high.status, 2);
    assert.match(high.stderr, /--max-tokens must be 200\.\.6000/);
    const low = run(root, ['context', '--task', TASK, '--max-tokens', '199']);
    assert.equal(low.status, 2);
    const small = run(root, ['context', '--task', TASK, '--max-tokens', '200', '--json']);
    assert.equal(small.status, 0, small.stderr);
    assert.ok(small.stdout.length <= 800 + 1, 'the JSON stays within 200 tokens of chars/4');
  } finally {
    removeFixture(root);
  }
});

test('--base is a value, not a flag: a known branch is used, an unknown one exits 2 as unknown_ref, a flag-like one as invalid_ref', () => {
  const root = seededRepo();
  try {
    const ok = run(root, ['context', '--task', TASK, '--base', 'main', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).base.ref, 'main');
    const unknown = run(root, ['context', '--task', TASK, '--base', 'no-such-branch']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown ref/);
    const flagLike = run(root, ['context', '--task', TASK, '--base', '-x']);
    assert.equal(flagLike.status, 2);
    assert.match(flagLike.stderr, /invalid ref/);
  } finally {
    removeFixture(root);
  }
});

test('--expand prints the span for an evidence ID from the packet', () => {
  const root = seededRepo();
  try {
    const r = run(root, ['context', '--expand', 'ev:src/route.mjs:1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /return handle\(req\.body\);/);
    assert.equal(run(root, ['context', '--expand', 'ev:../secrets:1']).status, 2);
  } finally {
    removeFixture(root);
  }
});

test('two separate processes on the same tree print byte-identical packet JSON (T6)', () => {
  const root = seededRepo();
  try {
    write(root, 'src/helpers.mjs', 'export function formatOrder(items) { return items.map((i) => i); }\n');
    const first = run(root, ['context', '--task', TASK, '--json']);
    const second = run(root, ['context', '--task', TASK, '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  } finally {
    removeFixture(root);
  }
});

test('context writes nothing outside .map-it-all/ (the packet is never stored)', () => {
  const root = seededRepo();
  try {
    write(root, 'src/helpers.mjs', 'export function formatOrder(items) { return items.map((i) => i); }\n');
    const before = treeOf(root);
    assert.equal(run(root, ['context', '--task', TASK, '--json']).status, 0);
    assert.equal(run(root, ['context', '--task', TASK, '--base', 'main', '--json']).status, 0);
    assert.deepEqual(treeOf(root), before, 'the project tree is byte-identical outside .map-it-all/');
  } finally {
    removeFixture(root);
  }
});
