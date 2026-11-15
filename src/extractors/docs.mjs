// Markdown files with inbound links, so "archive only when nothing links in" is a lookup.

import path from 'node:path';
import { escapeRe, finalize, pathTokens, ref } from '../records.mjs';

// Read by tools and readers without a link: agent entry files, repo health files, GitHub templates.
const ENTRY = (f) => /(^|\/)(README|CLAUDE|AGENTS|GEMINI|SKILL|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|CREDITS)(\.[\w-]+)?\.md$/i.test(f)
  || /^(\.agents|\.claude|\.cursor|\.github|licenses)\//.test(f);

export function extract(ctx) {
  const docs = ctx.files.filter((f) => f.endsWith('.md'));
  const byBase = new Map();
  for (const d of docs) byBase.set(path.posix.basename(d), (byBase.get(path.posix.basename(d)) ?? 0) + 1);

  // basename -> [{ file, token }] for every `...name.md` token in any text file.
  const mentions = new Map();
  for (const f of ctx.textFiles) {
    for (const m of pathTokens(ctx.read(f), /[\w-]\.md$/)) {
      const base = path.posix.basename(m);
      if (!mentions.has(base)) mentions.set(base, []);
      mentions.get(base).push({ file: f, token: m });
    }
  }
  const records = docs.map((d) => {
    const base = path.posix.basename(d);
    const ambiguous = byBase.get(base) > 1;
    const dir = path.posix.basename(path.posix.dirname(d));
    const refs = (mentions.get(base) ?? [])
      .filter((x) => x.file !== d && (!ambiguous || x.token.endsWith(`${dir}/${base}`)))
      .map((x) => ref(x.file, null, 'link', escapeRe(base)));
    return finalize({
      id: `doc:${d}`, kind: 'doc', name: d, path: d, line: 1, public: false, history: ctx.isHistory(d), entry: ENTRY(d), refs, flags: [],
    }, ctx);
  });
  return { records };
}
