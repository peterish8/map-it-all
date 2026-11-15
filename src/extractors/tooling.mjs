// Tooling: script files, npm scripts, tests outside every runner glob, env vars, web workers.
// "Tests outside any runner" is a real finding: a test no gate runs protects nothing.

import path from 'node:path';
import { globToRegExp } from '../config.mjs';
import { escapeRe, finalize, ref } from '../records.mjs';

const LIFECYCLE = /^(test|start|build|dev|lint|prepare|install|ci|(pre|post).+)$/;
const PLATFORM_ENV = /^(NODE_ENV|CI|PORT|HOME|USERPROFILE|PATH|APPDATA|TEMP|TMPDIR|LANG|PWD|SHELL|VERCEL(_.*)?|GITHUB_.*|RUNNER_.*|NEXT_RUNTIME|ANDROID_.*|JAVA_HOME|EXPO_OS)$/;

export function extract(ctx) {
  return { records: [...scriptFiles(ctx), ...npmScripts(ctx), ...strayTests(ctx), ...envVars(ctx), ...workers(ctx)] };
}

// ---- script files ----

function scriptFiles(ctx) {
  const isScript = (f) => /^(scripts|tools|bin|mocks)\//.test(f) || /^(apps|packages)\/[^/]+\/(scripts|bin)\//.test(f);
  const wanted = ctx.files.filter((f) => isScript(f) && /\.(mjs|cjs|js|ts|sh|ps1|py)$/.test(f));
  const mentions = new Map();
  for (const f of ctx.textFiles) {
    for (const m of new Set(ctx.read(f).match(/[\w@./-]*[\w-]+\.(?:mjs|cjs|js|ts|sh|ps1|py)\b/g) ?? [])) {
      const base = path.posix.basename(m);
      if (!mentions.has(base)) mentions.set(base, new Set());
      mentions.get(base).add(f);
    }
  }
  return wanted.map((f) => {
    const base = path.posix.basename(f);
    const all = [...(mentions.get(base) ?? [])].filter((g) => g !== f);
    const live = all.filter((g) => !ctx.isHistory(g));
    const rec = {
      id: `script:${f}`, kind: 'script-file', name: f, path: f, line: 1, public: false,
      refs: live.map((g) => ref(g, null, 'mention', escapeRe(base))), flags: [],
    };
    if (live.length === 0 && all.length > 0) rec.flags.push('history-only-refs');
    return finalize(rec, ctx);
  });
}

// ---- npm scripts ----

function packageFiles(ctx) {
  return ctx.files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules'));
}

function npmScripts(ctx) {
  const haystack = ctx.textFiles.filter((f) => !ctx.isHistory(f) && !f.endsWith('package-lock.json')
    && (/\.(md|ya?ml|json|mjs|cjs|sh|ps1)$/.test(f)));
  const out = [];
  for (const pkgPath of packageFiles(ctx)) {
    let scripts;
    try { scripts = JSON.parse(ctx.read(pkgPath)).scripts ?? {}; } catch { continue; }
    for (const name of Object.keys(scripts)) {
      const esc = escapeRe(name);
      const call = new RegExp(`(?:\\brun(?:-script)?\\s+(?:-\\S+\\s+)*|\\bnpm(?:\\.cmd)?\\s+|\\b(?:pnpm|yarn|bun)\\s+)${esc}(?![\\w:-])`);
      const refs = [];
      for (const f of haystack) {
        const text = ctx.read(f);
        const m = text.match(call);
        if (m) refs.push(ref(f, text.slice(0, m.index).split('\n').length, 'run'));
      }
      out.push(finalize({
        id: `npm-script:${pkgPath}#${name}`, kind: 'npm-script', name, path: pkgPath,
        line: ctx.firstLine(pkgPath, esc), public: false, entry: LIFECYCLE.test(name), refs, flags: [],
      }, ctx));
    }
  }
  return out;
}

// ---- tests outside every runner ----

function strayTests(ctx) {
  const covered = [];
  for (const pkgPath of packageFiles(ctx)) {
    const dir = path.posix.dirname(pkgPath) === '.' ? '' : `${path.posix.dirname(pkgPath)}/`;
    let scripts;
    try { scripts = JSON.parse(ctx.read(pkgPath)).scripts ?? {}; } catch { continue; }
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!/test|vitest|jest|playwright/.test(name) && !/--test|vitest|jest|playwright/.test(cmd)) continue;
      for (const m of cmd.matchAll(/["']?([\w./*-]*\*[\w./*-]*)["']?/g)) covered.push(globToRegExp(dir + m[1].replace(/^\.\//, '')));
      for (const m of cmd.matchAll(/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?/g)) covered.push(globToRegExp(dir + m[0].replace(/^\.\//, '')));
      // `node --test test/` and `vitest run src` run whole folders.
      for (const m of cmd.matchAll(/(?:--test|vitest(?:\s+run)?|jest)\s+((?:[\w./-]+\/)+)/g)) covered.push(globToRegExp(`${dir}${m[1].replace(/^\.\//, '')}**`));
    }
  }
  // Runner configs that live outside package scripts.
  const matchers = [];
  for (const f of ctx.files) {
    if (!/(^|\/)(playwright|vitest|jest)\.config\.[cm]?[jt]s$/.test(f)) continue;
    const dir = path.posix.dirname(f) === '.' ? '' : `${path.posix.dirname(f)}/`;
    const text = ctx.read(f);
    for (const m of text.matchAll(/testMatch:\s*\/(.+?)\/[a-z]*\s*[,}]/g)) matchers.push({ dir, re: new RegExp(m[1]) });
    if (/testDir:|testMatch|include:/.test(text) || /jest\.config/.test(f)) covered.push(globToRegExp(`${dir}**`));
  }

  const out = [];
  for (const f of ctx.files) {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || ctx.isHistory(f)) continue;
    if (covered.some((re) => re.test(f))) continue;
    if (matchers.some((m) => f.startsWith(m.dir) && m.re.test(path.posix.basename(f)))) continue;
    out.push(finalize({
      id: `test:${f}`, kind: 'test-file', name: f, path: f, line: 1, public: false, entry: true,
      refs: [], flags: ['outside-runner-globs'],
    }, ctx));
  }
  return out;
}

// ---- env vars ----

function envVars(ctx) {
  const reads = new Map();
  const codeSet = new Set(ctx.codeFiles);
  const readRe = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]|import\.meta\.env\.([A-Z][A-Z0-9_]+)/;
  for (const hit of ctx.grep(readRe, (f) => codeSet.has(f) && !ctx.isTest(f))) {
    const name = hit.groups.find(Boolean);
    if (PLATFORM_ENV.test(name)) continue;
    if (!reads.has(name)) reads.set(name, []);
    reads.get(name).push(`${hit.path}:${hit.line}`);
  }
  const setterIndex = ctx.tokenIndex((f) => /(^|\/)\.env[\w.]*$/.test(f) || f.startsWith('.github/') || /(^|\/)(vercel|netlify|wrangler|fly|render)\.(json|toml|ya?ml)$/.test(f)
    || /\.env\.example$/.test(f) || /(^|\/)docker-compose[\w.]*\.ya?ml$/.test(f) || /(^|\/)Dockerfile$/.test(f) || f.startsWith('docs/') || /env/i.test(path.posix.basename(f)));
  const out = [];
  for (const [name, where] of reads) {
    const setters = [...(setterIndex.get(name) ?? [])];
    const rec = {
      id: `env:${name}`, kind: 'env-var', name, path: where[0].split(':')[0], line: Number(where[0].split(':')[1]),
      public: false, entry: true, readers: where.slice(0, 20), readerCount: where.length,
      refs: setters.map((f) => ref(f, null, 'config', name)), flags: [],
    };
    if (setters.length === 0) rec.flags.push('read-not-set-in-checkout');
    out.push(finalize(rec, ctx));
  }
  return out;
}

// ---- workers ----

function workers(ctx) {
  const out = [];
  const codeSet = new Set(ctx.codeFiles);
  const re = /new\s+Worker\(\s*new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/;
  for (const hit of ctx.grep(re, (f) => codeSet.has(f))) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(hit.path), hit.groups[0]));
    const exists = ['', '.ts', '.js', '.mjs'].some((ext) => ctx.has(target + ext));
    out.push(finalize({
      id: `worker:${hit.path}:${hit.line}`, kind: 'worker', name: target, path: hit.path, line: hit.line, public: false,
      entry: true, refs: [], flags: exists ? [] : ['target-missing'],
    }, ctx));
  }
  return out;
}
