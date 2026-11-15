// Record helpers shared by every extractor.
//
// A record is one thing in the codebase that something else can reference: a route, a Convex
// function, a native module, a script, a doc. `finalize` attaches counts and flags.

export const REF_CAP = 40;

export const norm = (p) => p.replaceAll('\\', '/');

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');

export function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * A reference. Pass `line = null` plus a regex-safe `word` to look the line up only if the ref is kept,
 * which keeps hot records (hundreds of refs) cheap.
 */
export function ref(path, line, how, word) {
  return { path, line, how, word };
}

/**
 * Attach counts and flags; cap stored refs. `entry` means the record is reached by an external
 * mechanism (a cron, a URL, a manifest) so having no refs is expected.
 */
export function finalize(record, ctx) {
  const refs = record.refs ?? [];
  const prod = refs.filter((r) => !ctx.isTest(r.path));
  const flags = new Set(record.flags ?? []);
  if (!record.entry) {
    if (prod.length === 0 && refs.length > 0) flags.add('test-only');
    else if (prod.length === 0) flags.add('no-refs');
  }
  return {
    ...record,
    flags: [...flags].sort(),
    refCount: refs.length,
    prodRefCount: prod.length,
    refs: refs.slice(0, REF_CAP).map(({ path, line, how, word }) => ({
      path, line: line ?? ctx.firstLine(path, word), how,
    })),
  };
}
