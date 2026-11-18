// Analysis context: the file list, cached reads, regex search, an identifier index and the ast-grep
// runner. Pure Node, no network. Everything reflects the working tree, uncommitted edits included.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, loadConfig } from './config.mjs';
import { isRealInside, isRealInsideOf, realRootOf } from './paths.mjs';
import { lineAt, norm } from './records.mjs';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.yml', '.yaml', '.toml',
  '.kt', '.java', '.xml', '.gradle', '.pro', '.rs', '.html', '.css', '.sh', '.ps1', '.py', '.properties', '.swift', '.go',
]);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_BYTES = 1_500_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.map-it-all', 'dist', '.next', 'build', 'target', '.gradle', '.expo', '.turbo', 'coverage', '.venv']);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

export function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function walk(root, dir = '', out = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Tracked plus untracked-not-ignored files that exist on disk (git), or a directory walk outside git.
 * One lstat per file gives both "does it exist" and its size, so reads never stat again. A path whose
 * directories or own link resolve outside the project is skipped and reported in `skipped`, never read.
 */
export function scanFiles(root, ignore = []) {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  const names = listed === null ? walk(root) : listed.split('\0').filter(Boolean).map(norm);
  const extra = ignore.map(globToRegExp);
  const sizes = new Map();
  const files = [];
  const skipped = [];
  // A junction in the middle of a path leads outside without the last component being a link, so each
  // directory is checked once (a few hundred realpath calls, not one per file).
  const dirInside = new Map();
  const realRootPath = realRootOf(root);
  const inside = (dir) => {
    if (!dirInside.has(dir)) dirInside.set(dir, isRealInsideOf(realRootPath, path.join(root, dir)));
    return dirInside.get(dir);
  };
  for (const f of new Set(names)) {
    if (f.split('/').some((seg) => SKIP_DIRS.has(seg)) || SKIP_FILES.has(path.posix.basename(f)) || extra.some((re) => re.test(f))) continue;
    try {
      const abs = path.join(root, f);
      if (!inside(path.posix.dirname(f))) { skipped.push(f); continue; }
      const link = lstatSync(abs);
      let s = link;
      if (link.isSymbolicLink()) {
        if (!isRealInsideOf(realRootPath, abs)) { skipped.push(f); continue; }
        s = statSync(abs);
      }
      if (!s.isFile()) continue;
      sizes.set(f, s.size);
      files.push(f);
    } catch { /* deleted in the working tree but still listed */ }
  }
  return { files: files.sort(), sizes, skipped: skipped.sort() };
}

/** Bytes of a file in the project. Throws when the path resolves outside the project, so it is never read. */
function readInside(root, f) {
  const abs = path.join(root, f);
  if (!isRealInside(root, abs)) throw new Error(`${f} resolves outside the project`);
  return readFileSync(abs);
}

export const listFiles = (root, ignore = []) => scanFiles(root, ignore).files;

/** HEAD, branch and a hash of the working-tree state. Two equal fingerprints mean an equal map. */
export function fingerprint(root) {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim() ?? 'no-git';
  const branch = git(root, ['branch', '--show-current'])?.trim() ?? '';
  const porcelain = git(root, ['status', '--porcelain=v1', '-uall', '-z']) ?? '';
  const hash = createHash('sha1').update(head);
  let dirty = 0;
  for (const entry of porcelain.split('\0').filter(Boolean)) {
    dirty++;
    hash.update(entry);
    try {
      const s = statSync(path.join(root, entry.slice(3)));
      hash.update(`${s.mtimeMs}:${s.size}`);
    } catch { hash.update('gone'); }
  }
  // Lockfiles are intentionally excluded from the file map, but their contents determine installed
  // dependency versions. Include them here so lockfile-only changes rebuild even outside Git.
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  const names = listed === null ? walk(root) : listed.split('\0').filter(Boolean).map(norm);
  // Gitignored lockfiles still govern installed versions (the deps extractor reads them from disk), so
  // also probe every directory at or above a package.json, ignored or not.
  const locks = new Set(names.filter((name) => SKIP_FILES.has(path.posix.basename(name))));
  const manifests = names.filter((name) => path.posix.basename(name) === 'package.json');
  const dirs = new Set(['']);
  for (const n of names) {
    if (path.posix.basename(n) !== 'package.json') continue;
    for (let d = path.posix.dirname(n); d !== '.' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  for (const d of dirs) for (const l of SKIP_FILES) if (existsSync(path.join(root, d, l))) locks.add(d ? `${d}/${l}` : l);
  for (const f of [...locks].sort()) {
    try { hash.update(`${f}:`).update(readInside(root, f)); } catch { hash.update(`${f}:gone`); }
  }
  // Dependency ranges are build inputs even when a manifest edit preserves file size and mtime.
  for (const f of manifests.sort()) {
    hash.update(`manifest:${f}:`);
    try { hash.update(readInside(root, f)); } catch { hash.update(existsSync(path.join(root, f)) ? '<unreadable>' : '<missing>'); }
  }
  return { head, branch, dirty, dirtyHash: hash.digest('hex').slice(0, 16) };
}

export function isTestPath(f) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|__mocks__)\//.test(f)
    || /^(tests?|spec|e2e)\//.test(f) || /\/src\/(test|androidTest)\//.test(f) || /(^|\/)testing\.[jt]s$/.test(f);
}

function findAstGrep(root) {
  if (process.env.AST_GREP_BIN) return process.env.AST_GREP_BIN;
  // Inside a clone it sits in our own node_modules; under npx or as a dependency it is a sibling of this
  // package (…/node_modules/@ast-grep/cli next to …/node_modules/map-it-all); the project may also have it.
  for (const modules of [path.join(PKG_ROOT, 'node_modules'), path.dirname(PKG_ROOT), path.join(root, 'node_modules')]) {
    const dir = path.join(modules, '@ast-grep', 'cli');
    const bin = path.join(dir, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
    if (existsSync(path.join(dir, 'package.json')) && existsSync(bin)) return bin;
  }
  throw new Error('ast-grep not found. Run `npm install` inside the map-it-all folder, or set AST_GREP_BIN.');
}

function launcherFor(bin) {
  // npm leaves a node shim where the native binary goes when postinstall is skipped.
  const fd = openSync(bin, 'r');
  const head = Buffer.alloc(64);
  readSync(fd, head, 0, 64, 0);
  closeSync(fd);
  const first = head.toString('utf8');
  return first.startsWith('#!') && first.includes('node') ? [process.execPath, [bin]] : [bin, []];
}

export function createContext(root, config = loadConfig(root)) {
  root = path.resolve(root);
  const { files, sizes, skipped } = scanFiles(root, config.ignore);
  const fileSet = new Set(files);
  const cache = new Map();
  const history = config.historyDirs.map((d) => d.replace(/\/+$/, ''));
  const inHistory = (f) => history.some((d) => f === d || f.startsWith(`${d}/`));
  // Replayed or archived source must not create callers, import edges or routes. History docs stay
  // visible: "referenced only from history" is a finding in its own right.
  const HISTORY_CODE = /\.(tsx?|jsx?|mjs|cjs|kt|java|rs|py|go|swift|gradle)$/;
  const codeFiles = files.filter((f) => CODE_EXT.has(path.posix.extname(f)) && !f.endsWith('.d.ts') && !inHistory(f));
  const codeSet = new Set(codeFiles);
  let astGrep;
  let ruleDir;

  const ctx = {
    root,
    config,
    files,
    skipped,
    has: (f) => fileSet.has(f),
    isTest: isTestPath,
    isHistory: inHistory,
    read(f) {
      if (!cache.has(f)) {
        let text = '';
        try {
          if ((sizes.get(f) ?? 0) <= MAX_BYTES) text = readFileSync(path.join(root, f), 'utf8');
        } catch { /* unreadable counts as empty */ }
        cache.set(f, text);
      }
      return cache.get(f);
    },
    textFiles: files.filter((f) => TEXT_EXT.has(path.posix.extname(f)) && !(inHistory(f) && HISTORY_CODE.test(f))),
    codeFiles,
    isCode: (f) => codeSet.has(f),

    /** Every regex hit across files matching `pick`: [{ path, line, match, groups, index }]. */
    grep(regex, pick = () => true) {
      const out = [];
      const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
      for (const f of ctx.textFiles) {
        if (!pick(f)) continue;
        const text = ctx.read(f);
        if (!text) continue;
        for (const m of text.matchAll(new RegExp(regex.source, flags))) {
          out.push({ path: f, line: lineAt(text, m.index), match: m[0], groups: m.slice(1), index: m.index });
        }
      }
      return out;
    },

    /**
     * Run ast-grep rules (YAML text, rules separated by `---`) over the repo. `text: true` also returns the
     * matched source text. Matches come back normalised: { ruleId, file, line, vars, text? }.
     */
    sg(yaml, { text = false } = {}) {
      astGrep ??= launcherFor(findAstGrep(root));
      ruleDir ??= mkdtempSync(path.join(tmpdir(), 'map-it-all-'));
      const file = path.join(ruleDir, `rules-${createHash('sha1').update(yaml).digest('hex').slice(0, 10)}.yml`);
      writeFileSync(file, yaml);
      const [cmd, pre] = astGrep;
      const r = spawnSync(cmd, [...pre, 'scan', '-r', file, '--json=compact', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
      let parsed;
      try { parsed = JSON.parse(r.stdout || '[]'); } catch { parsed = null; }
      if (!Array.isArray(parsed)) throw new Error(`ast-grep failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
      return parsed.map((m) => ({
        ruleId: m.ruleId,
        file: norm(m.file),
        line: m.range.start.line + 1,
        vars: Object.fromEntries(Object.entries(m.metaVariables?.single ?? {}).map(([k, v]) => [k, v.text])),
        ...(text ? { text: m.text } : {}),
      }));
    },

    /** identifier -> Set(file) over the files `pick` accepts. */
    tokenIndex(pick) {
      const index = new Map();
      for (const f of ctx.textFiles) {
        if (!pick(f)) continue;
        for (const token of new Set(ctx.read(f).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])) {
          if (!index.has(token)) index.set(token, new Set());
          index.get(token).add(f);
        }
      }
      return index;
    },

    firstLine(f, word) {
      const text = ctx.read(f);
      const m = text.match(new RegExp(`\\b${word}\\b`));
      return m ? lineAt(text, m.index) : 1;
    },

    dispose() { if (ruleDir) rmSync(ruleDir, { recursive: true, force: true }); },
  };
  return ctx;
}
