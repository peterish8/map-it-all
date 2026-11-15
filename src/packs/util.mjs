// Helpers for packs that drive ast-grep.

// ast-grep parses by language, and .ts, .tsx and .js are three of them.
const LANGS = [
  ['TypeScript', /\.(ts|mts|cts)$/],
  ['Tsx', /\.tsx$/],
  ['JavaScript', /\.(js|mjs|cjs|jsx)$/],
];

const IGNORES = ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**', '**/.map-it-all/**'];

/**
 * Build one rule per language. `files` is an explicit list to restrict to (omit to scan everything).
 * `make(language, filesYaml, ignoresYaml, idSuffix)` returns the rule YAML.
 */
export function rulesFor(files, make) {
  const docs = [];
  for (const [language, re] of LANGS) {
    let scoped = null;
    if (files) {
      scoped = files.filter((f) => re.test(f));
      if (!scoped.length) continue;
    }
    docs.push(make({
      language,
      suffix: `@${language}`,
      filesLine: scoped ? `files: ${JSON.stringify(scoped)}\n` : '',
      ignoresLine: `ignores: ${JSON.stringify(IGNORES)}\n`,
      ignoresWith: (extra) => `ignores: ${JSON.stringify([...IGNORES, ...extra])}\n`,
    }));
  }
  return docs.join('\n---\n');
}

/** Normalise ast-grep rule ids back (the per-language suffix is an implementation detail). */
export const baseId = (id) => id.replace(/@(TypeScript|Tsx|JavaScript)$/, '');

export const unquote = (s) => s.replace(/^[`'"]|[`'"]$/g, '');

/** Split a call's argument text on top-level commas. */
export function splitArgs(text) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; }
    else if ('([{'.includes(c)) { depth++; cur += c; }
    else if (')]}'.includes(c)) { depth--; cur += c; }
    else if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
