// Budgets and caps for evidence packets. chars/4 is an approximation, and every output says so. The byte and
// item caps are the hard protection when the token estimate is unavailable. Nothing is clipped silently:
// each cut is reported as an omission with a reason and a count.

export const DEFAULT_TOKENS = 3000;
export const HARD_CAP_TOKENS = 6000;
export const MIN_TOKENS = 200;
export const MAX_ITEMS = 40;
export const MAX_ITEM_CHARS = 400;
export const FANOUT_CAP = 25;
export const DEPTH_CAP = 2;
export const ESTIMATOR = 'chars/4 (approximate)';

export const estimateTokens = (text) => Math.ceil(text.length / 4);

/** Tokens to characters. Out-of-range or non-integer values throw `{ code: 'usage' }`; they are never clamped. */
export function budgetFor(maxTokens) {
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_TOKENS || maxTokens > HARD_CAP_TOKENS) {
    throw Object.assign(new Error(`--max-tokens must be ${MIN_TOKENS}..${HARD_CAP_TOKENS}`), { code: 'usage' });
  }
  return { maxTokens, maxChars: maxTokens * 4 };
}

/** Cuts text to `max` characters, ending with an ellipsis when it was cut. */
export function capText(text, max = MAX_ITEM_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

/** Caps every item's `text` and returns one omission when any was cut. */
export function capItemTexts(items) {
  let count = 0;
  const out = items.map((item) => {
    if (typeof item.text !== 'string') return item;
    const { text, truncated } = capText(item.text);
    if (truncated) count++;
    return truncated ? { ...item, text } : item;
  });
  const omissions = count ? [{ reason: 'item_text_truncated', count, detail: `text longer than ${MAX_ITEM_CHARS} chars was cut` }] : [];
  return { items: out, omissions };
}

/** Keeps the first `max` items (the caller sorts them by rank first) and reports the rest. */
export function capItems(items, max = MAX_ITEMS) {
  if (items.length <= max) return { items, omissions: [] };
  return { items: items.slice(0, max), omissions: [{ reason: 'item_cap', count: items.length - max, detail: `items beyond ${max} were not shown` }] };
}
