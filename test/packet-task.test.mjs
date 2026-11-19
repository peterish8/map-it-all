// Task context packet (CTX-01, CTX-03): the seeded caller chain, memory leads, caps, determinism and expansion.
// Truth IDs (T1..T7) match 05-01-PLAN.md.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../src/build.mjs';
import { createMemory } from '../src/memory.mjs';
import { buildTaskContext, expandEvidence } from '../src/packet/task.mjs';
import { loadStore } from '../src/store.mjs';
import { gitFixture, removeFixture, write } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK = 'change formatOrder return shape in helpers, handler and route';
const HELPERS_BASE = 'export function formatOrder(items) { return { count: items.length, items }; }\n';
const HELPERS_CHANGED = 'export function formatOrder(items) { return items.map((item) => item); }\n';
const CHAIN = {
  'src/helpers.mjs': HELPERS_BASE,
  'src/handler.mjs': "import { formatOrder } from './helpers.mjs';\nexport function handle(body) { return formatOrder(body.items).count; }\n",
  'src/route.mjs': "import { handle } from './handler.mjs';\nexport function route(req) {\n  return handle(req.body);\n}\n",
  'src/memory-anchor.txt': 'handler notes live here\n',
};

/**
 * The seeded repo of 05-FIXTURES §1: a base commit, a handler note written before the uncommitted change to
 * helpers, a route note written after it, then the map. Returns what the packet builders need.
 */
async function seeded() {
  const root = gitFixture({ files: CHAIN });
  const out = path.join(root, '.map-it-all');
  const memory = createMemory({ root, dir: path.join(out, 'memory') });
  memory.remember({ title: 'handler contract', body: 'handler returns the count of items', kind: 'fact', anchors: ['src/handler.mjs'] });
  write(root, 'src/helpers.mjs', HELPERS_CHANGED);
  memory.remember({ title: 'route contract', body: 'route forwards req.body to handle', kind: 'fact', anchors: ['src/route.mjs'] });
  await buildMap({ root, out });
  return { root, out, store: loadStore(out), memory };
}

/** A helper with `count` importers in a repo of its own (fanout and budget tests). */
async function fanout(count) {
  const files = { 'src/helpers.mjs': HELPERS_BASE };
  for (let i = 0; i < count; i++) {
    files[`src/callers/c${String(i).padStart(2, '0')}.mjs`] = `import { formatOrder } from '../helpers.mjs';\nexport const c${i} = formatOrder([${i}]);\n`;
  }
  const root = gitFixture({ files });
  write(root, 'src/helpers.mjs', HELPERS_CHANGED);
  const out = path.join(root, '.map-it-all');
  await buildMap({ root, out });
  return { root, out, store: loadStore(out), memory: createMemory({ root, dir: path.join(out, 'memory') }) };
}

test('T1 the default packet fits 3,000 estimated tokens (12,000 chars) and labels its estimator as approximate', async () => {
  const { root, store, memory } = await seeded();
  try {
    const packet = buildTaskContext({ root, store, memory, task: TASK });
    assert.equal(packet.budget.maxTokens, 3000);
    assert.equal(packet.budget.hardCapTokens, 6000);
    assert.match(packet.budget.estimator, /approximate/);
    assert.ok(JSON.stringify(packet).length <= 12000, 'T1: the packet is at most 12,000 chars');
    assert.ok(packet.budget.usedTokens <= 3000, 'T1: usedTokens is within the budget');
  } finally {
    removeFixture(root);
  }
});

test('T2 every item has source, confidence, reason and an evidence ID that expands, in rank order', async () => {
  const { root, store, memory } = await seeded();
  try {
    const packet = buildTaskContext({ root, store, memory, task: TASK });
    const rank = { changed: 0, importer: 1, record: 2, 'memory-verified': 3, 'memory-lead': 4 };
    for (const item of packet.items) {
      assert.ok(item.source && item.reason, `T2: ${item.kind} ${item.path} has source and reason`);
      assert.ok(['exact', 'heuristic', 'validated'].includes(item.confidence), `T2: ${item.kind} has a known confidence`);
      assert.match(item.id, /^ev:[^:]+:\d+$/, `T2: ${item.kind} ${item.path} has an evidence ID`);
      assert.ok(expandEvidence({ root, id: item.id }).text !== undefined, `T2: ${item.id} expands`);
    }
    const kinds = packet.items.map((i) => rank[i.kind]);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => a - b), 'T2: items are ordered by kind rank');
    const changed = packet.items.find((i) => i.kind === 'changed');
    assert.deepEqual([changed.path, changed.confidence, changed.source], ['src/helpers.mjs', 'exact', 'git-status']);
  } finally {
    removeFixture(root);
  }
});

test('T3 the caller two hops from a changed helper is listed at depth 2 with its chain, and expansion returns its span', async () => {
  const { root, store, memory } = await seeded();
  try {
    const packet = buildTaskContext({ root, store, memory, task: TASK });
    const route = packet.items.find((i) => i.kind === 'importer' && i.path === 'src/route.mjs');
    assert.ok(route, 'T3: route.mjs is listed as an importer');
    assert.equal(route.depth, 2, 'T3: depth 2');
    assert.equal(route.confidence, 'heuristic');
    assert.match(route.reason, /src\/handler\.mjs/, 'T3: the reason names the middle file');
    assert.match(route.reason, /src\/helpers\.mjs/, 'T3: the reason names the changed file');
    const span = expandEvidence({ root, id: route.id });
    assert.equal(span.path, 'src/route.mjs');
    assert.match(span.text, /return handle\(req\.body\);/, 'T3: the expanded span contains the caller');
  } finally {
    removeFixture(root);
  }
});

test('T4 a note on a direct importer of a changed file is a lead, and a fresh note on a deeper file is verified', async () => {
  const { root, store, memory } = await seeded();
  try {
    const packet = buildTaskContext({ root, store, memory, task: TASK });
    const handler = packet.items.find((i) => i.path === 'src/handler.mjs' && i.kind.startsWith('memory'));
    assert.equal(handler?.kind, 'memory-lead', 'T4: the handler note is a lead, never verified');
    assert.match(handler.reason, /verify before relying on it/);
    const route = packet.items.find((i) => i.path === 'src/route.mjs' && i.kind.startsWith('memory'));
    assert.equal(route?.kind, 'memory-verified', 'T4: the fresh route note is verified');
    assert.equal(route.confidence, 'validated');
  } finally {
    removeFixture(root);
  }
});

test('T4 a note anchored to the changed file itself is a lead even when it was written before the change', async () => {
  const root = gitFixture({ files: CHAIN });
  try {
    const out = path.join(root, '.map-it-all');
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    memory.remember({ title: 'helpers contract', body: 'formatOrder returns a count object', anchors: ['src/helpers.mjs'] });
    write(root, 'src/helpers.mjs', HELPERS_CHANGED);
    await buildMap({ root, out });
    const packet = buildTaskContext({ root, store: loadStore(out), memory, task: 'helpers contract' });
    const note = packet.items.find((i) => i.kind === 'memory-lead' && i.path === 'src/helpers.mjs');
    assert.ok(note, 'T4: a lead for the changed file');
    assert.match(note.reason, /verify before relying on it/);
    assert.equal(packet.items.some((i) => i.kind === 'memory-verified' && i.path === 'src/helpers.mjs'), false, 'T4: never verified');
  } finally {
    removeFixture(root);
  }
});

test('T5 fanout past 25 importers is reported with its count, and the first 25 in path order are shown', async () => {
  const { root, store, memory } = await fanout(60);
  try {
    const packet = buildTaskContext({ root, store, memory, task: 'formatOrder' });
    const importers = packet.items.filter((i) => i.kind === 'importer' && i.depth === 1);
    assert.equal(importers.length, 25, 'T5: 25 importers shown');
    assert.equal(importers[0].path, 'src/callers/c00.mjs', 'T5: shown in path order');
    const omission = packet.omissions.find((o) => o.reason === 'fanout_capped');
    assert.equal(omission?.count, 35, 'T5: fanout_capped with the count 35');
  } finally {
    removeFixture(root);
  }
});

test('T5 a memory note longer than 400 chars is cut and reported as item_text_truncated', async () => {
  const { root, store, memory } = await seeded();
  try {
    memory.remember({ title: 'route long note', body: 'route handles bodies. '.repeat(60), kind: 'fact', anchors: ['src/route.mjs'] });
    const packet = buildTaskContext({ root, store, memory, task: 'route long note' });
    const item = packet.items.find((i) => i.kind.startsWith('memory') && typeof i.text === 'string');
    assert.ok(item, 'T5: the note is an item with text');
    assert.ok(item.text.length <= 400 && item.text.endsWith('…'), 'T5: the text is at most 400 chars and marked cut');
    assert.ok(packet.omissions.some((o) => o.reason === 'item_text_truncated'), 'T5: the cut is reported');
  } finally {
    removeFixture(root);
  }
});

test('T5 a packet over the byte budget keeps itself under it and reports byte_cap', async () => {
  const { root, store, memory } = await fanout(60);
  try {
    const packet = buildTaskContext({ root, store, memory, task: 'formatOrder', maxTokens: 200 });
    assert.ok(JSON.stringify(packet).length <= 800, 'T5: 200 tokens = 800 chars, never more');
    assert.ok(packet.omissions.some((o) => o.reason === 'byte_cap'), 'T5: the dropped items are reported');
  } finally {
    removeFixture(root);
  }
});

test('T6 two builds give identical JSON, usage.modelCalls is 0, and the packet modules import no network or model code', async () => {
  const { root, store, memory } = await seeded();
  try {
    const a = JSON.stringify(buildTaskContext({ root, store, memory, task: TASK }));
    const b = JSON.stringify(buildTaskContext({ root, store, memory, task: TASK }));
    assert.equal(a, b, 'T6: byte-identical output for the same tree');
    assert.deepEqual(JSON.parse(a).usage, { modelCalls: 0 });
    const modules = [...readdirSync(path.join(ROOT, 'src', 'packet')).map((f) => path.join(ROOT, 'src', 'packet', f)), path.join(ROOT, 'src', 'gitref.mjs')];
    const forbidden = /['"][^'"]*(\bnet\.mjs|node:(?:http|https|net|dns|tls)|\/pr\/|\/models?\/)[^'"]*['"]/;
    for (const file of modules) assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, `T6: ${path.basename(file)} imports no network or model module`);
  } finally {
    removeFixture(root);
  }
});

test('T7 expansion refuses paths that leave the project (path_outside_root) and malformed IDs (bad_evidence_id)', async () => {
  const { root } = await seeded();
  try {
    for (const id of ['ev:../etc/passwd:1', 'ev:/etc/passwd:1', 'ev:C:/Windows/win.ini:1']) {
      assert.throws(() => expandEvidence({ root, id }), (e) => e.code === 'path_outside_root', `T7: ${id}`);
    }
    for (const id of ['ev:src/route.mjs:abc', 'nope', 'ev:src/route.mjs:0']) {
      assert.throws(() => expandEvidence({ root, id }), (e) => e.code === 'bad_evidence_id', `T7: ${id}`);
    }
  } finally {
    removeFixture(root);
  }
});

test('CTX-01 expansion returns ±10 lines around the ID, clipped to the file and to 60 lines', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const root = gitFixture({ files: { 'notes/long.txt': `${lines}\n` } });
  try {
    const span = expandEvidence({ root, id: 'ev:notes/long.txt:50' });
    assert.equal(span.startLine, 40);
    assert.equal(span.endLine, 60);
    assert.equal(span.text.split('\n').length, 21);
    const top = expandEvidence({ root, id: 'ev:notes/long.txt:1' });
    assert.equal(top.startLine, 1);
    assert.equal(top.endLine, 11);
    assert.equal(expandEvidence({ root, id: 'ev:notes/long.txt:50', maxLines: 5 }).text.split('\n').length, 5);
  } finally {
    removeFixture(root);
  }
});
