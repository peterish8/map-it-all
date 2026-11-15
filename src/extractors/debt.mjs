// Debt markers per file, counted so a tool can rank files.

import path from 'node:path';
import { finalize } from '../records.mjs';

const MARKERS = {
  todo: /\b(?:TODO|FIXME|HACK|XXX)\b/,
  tsSuppress: /@ts-ignore|@ts-expect-error|@ts-nocheck/,
  eslintDisable: /eslint-disable/,
  castUnknown: /\bas unknown as\b/,
  anyType: /:\s*any\b|<any>|\bas any\b/,
  consoleLog: /\bconsole\.log\(/,
};
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|kt|rs|py|go|swift)$/;

export function extract(ctx) {
  const records = [];
  for (const f of ctx.files) {
    if (!CODE.test(f) || f.includes('/_generated/') || ctx.isHistory(f)) continue;
    const counts = {};
    let total = 0;
    for (const line of ctx.read(f).split('\n')) {
      for (const [name, re] of Object.entries(MARKERS)) {
        if (re.test(line)) { counts[name] = (counts[name] ?? 0) + 1; total++; }
      }
    }
    if (total === 0) continue;
    records.push(finalize({
      id: `debt:${f}`, kind: 'debt', name: path.posix.basename(f), path: f, line: 1, public: false, entry: true,
      total, counts, refs: [], flags: Object.keys(counts).map((k) => `has-${k}`),
    }, ctx));
  }
  return { records };
}
