// Budgets and item caps for evidence packets (CTX-02). chars/4 is an approximation and is labelled as one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TOKENS, DEPTH_CAP, FANOUT_CAP, HARD_CAP_TOKENS, MAX_ITEMS, MAX_ITEM_CHARS, budgetFor, capItemTexts, capItems, estimateTokens } from '../src/packet/budget.mjs';

test('estimateTokens is chars/4 rounded up', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('budgetFor converts tokens to chars and throws usage outside 200..6000 (never clamps)', () => {
  assert.deepEqual(budgetFor(3000), { maxTokens: 3000, maxChars: 12000 });
  assert.equal(budgetFor(200).maxChars, 800);
  assert.equal(budgetFor(6000).maxChars, 24000);
  for (const bad of [6001, 199, 0, -1, 2.5, Number.NaN]) {
    assert.throws(() => budgetFor(bad), (error) => error.code === 'usage' && /--max-tokens must be 200\.\.6000/.test(error.message), `throws for ${bad}`);
  }
});

test('the documented defaults and caps are exported once', () => {
  assert.equal(DEFAULT_TOKENS, 3000);
  assert.equal(HARD_CAP_TOKENS, 6000);
  assert.equal(MAX_ITEMS, 40);
  assert.equal(MAX_ITEM_CHARS, 400);
  assert.equal(FANOUT_CAP, 25);
  assert.equal(DEPTH_CAP, 2);
});

test('an item text longer than 400 chars is cut to 400 with an ellipsis and reported as item_text_truncated', () => {
  const items = [{ id: 'ev:a.md:1', text: 'x'.repeat(500) }, { id: 'ev:b.md:1', text: 'short' }];
  const { items: capped, omissions } = capItemTexts(items);
  assert.equal(capped[0].text.length, 400);
  assert.ok(capped[0].text.endsWith('…'));
  assert.equal(capped[1].text, 'short');
  assert.deepEqual(omissions, [{ reason: 'item_text_truncated', count: 1, detail: 'text longer than 400 chars was cut' }]);
});

test('more than 40 items keep the first 40 and report the rest as item_cap with the count', () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: `ev:f${i}.mjs:1` }));
  const { items: kept, omissions } = capItems(items);
  assert.equal(kept.length, 40);
  assert.equal(kept[39].id, 'ev:f39.mjs:1');
  assert.deepEqual(omissions, [{ reason: 'item_cap', count: 5, detail: 'items beyond 40 were not shown' }]);
  assert.deepEqual(capItems(items.slice(0, 40)).omissions, []);
});
