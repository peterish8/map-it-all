import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createMemory } from '../src/memory.mjs';
import { fixture, write } from './fixtures.mjs';

function withMemory(fn) {
  const root = fixture();
  try { return fn(root, createMemory({ root, dir: path.join(root, '.map-it-all', 'memory') })); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a note anchored to a file goes stale when the file changes, orphaned when it vanishes', () => withMemory((root, memory) => {
  const saved = memory.remember({ title: 'lib.used is cached upstream', body: 'Do not add caching in the handler.', kind: 'gotcha', anchors: ['convex/lib.ts'], tags: ['Convex'] });
  assert.equal(saved.status, 'fresh');
  assert.equal(memory.recall({ query: 'caching handler' })[0].status, 'fresh');

  write(root, 'convex/lib.ts', 'export const used = 2;\n');
  const stale = memory.recall({ query: 'caching' })[0];
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.anchorStates, [{ path: 'convex/lib.ts', state: 'changed' }]);

  assert.equal(memory.confirm(saved.id).status, 'fresh', 'confirm re-verifies after the agent checked');

  rmSync(path.join(root, 'convex', 'lib.ts'));
  assert.equal(memory.recall({ query: 'caching' })[0].status, 'orphaned');
}));

test('line-ending churn is not staleness', () => withMemory((root, memory) => {
  write(root, 'notes.txt', 'a\r\nb\r\n');
  memory.remember({ title: 'eol', body: 'x', anchors: ['notes.txt'] });
  write(root, 'notes.txt', 'a\nb\n');
  assert.equal(memory.recall({ query: 'eol' })[0].status, 'fresh');
}));

test('validation: anchors must exist, bodies are bounded, same title replaces', () => withMemory((root, memory) => {
  assert.throws(() => memory.remember({ title: 't', body: 'b', anchors: ['nope/missing.ts'] }), /not a file/);
  assert.throws(() => memory.remember({ title: 't', body: 'x'.repeat(2001) }), /keep notes under/);
  assert.throws(() => memory.remember({ title: 't', body: 'b', kind: 'weird' }), /kind must be/);
  const first = memory.remember({ title: 'Same', body: 'one' });
  const second = memory.remember({ title: 'same', body: 'two' });
  assert.equal(first.id, second.id);
  assert.equal(second.replaced, true);
  assert.equal(memory.list().length, 1);
  assert.equal(memory.list()[0].body, 'two');
  assert.equal(memory.forget(first.id), true);
  assert.equal(memory.list().length, 0);
}));

test('recall ranks by title, tags, anchors and body, and filters by kind', () => withMemory((root, memory) => {
  memory.remember({ title: 'Routing rule', body: 'prefix every mount', kind: 'decision', tags: ['express'] });
  memory.remember({ title: 'Unrelated', body: 'routing appears only in the body', kind: 'fact' });
  assert.equal(memory.recall({ query: 'routing' })[0].title, 'Routing rule');
  assert.equal(memory.recall({ query: 'routing', kind: 'fact' }).length, 1);
  assert.equal(memory.recall({ query: 'nothing matches this' }).length, 0);
}));

test('handoff flags files that changed since it was saved', () => withMemory((root, memory) => {
  assert.equal(memory.readHandoff(), null);
  memory.saveHandoff({ summary: 'Wiring the cron', next_steps: ['run tests'], files: ['convex/crons.ts'] });
  assert.deepEqual(memory.readHandoff().changedFiles, []);
  write(root, 'convex/crons.ts', '// edited\n');
  assert.deepEqual(memory.readHandoff().changedFiles, [{ path: 'convex/crons.ts', state: 'changed' }]);
  assert.throws(() => memory.saveHandoff({ summary: '' }), /summary is required/);
}));
