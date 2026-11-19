// Task context packet (CTX-01..CTX-03): capped, provenance-tagged evidence for one task. It is built from the
// map (importers and records), Git and the working tree (changed paths) and file-anchored memory. Stateless:
// nothing is stored and no model is called, so the same tree gives the same bytes (AC-1, AC-8).

import { loadConfig } from '../config.mjs';
import { fingerprint } from '../context.mjs';
import { flagsOf } from '../store.mjs';
import { git, mergeBase, resolveCommit, validateRef } from '../gitref.mjs';
import { DEFAULT_TOKENS, DEPTH_CAP, ESTIMATOR, FANOUT_CAP, HARD_CAP_TOKENS, budgetFor, capItemTexts, capItems, capText, estimateTokens } from './budget.mjs';
import { evidenceId } from './evidence.mjs';

export { expandEvidence } from './evidence.mjs';

const RANK = { changed: 0, importer: 1, record: 2, 'memory-verified': 3, 'memory-lead': 4 };
const RESERVE_CHARS = 4; // room for the usedTokens digits, which are written after the size check
const TASK_CHARS = 400;
const SKIP_SEGMENTS = new Set(['node_modules', '.git']);

const fail = (code, message) => Object.assign(new Error(message), { code });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code units, never the locale, so output is the same everywhere

function gitOrThrow(root, args, what) {
  const r = git(root, args);
  if (r.status !== 0) throw fail('git_failed', `${what} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

const reasonFor = (xy) => {
  if (xy === '??' || xy.includes('A')) return 'added in working tree';
  if (xy.includes('D')) return 'deleted in working tree';
  if (xy.includes('R')) return 'renamed in working tree';
  return 'modified in working tree';
};

/** Working-tree changes: `git status --porcelain=v1 -z -uall`. A rename reports its new path. */
function worktreeChanges(root) {
  const parts = gitOrThrow(root, ['status', '--porcelain=v1', '-z', '-uall'], 'git status').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    out.push({ path: entry.slice(3), reason: reasonFor(xy), source: 'git-status' });
    if (xy.includes('R') || xy.includes('C')) i++; // the original path follows a rename or copy
  }
  return out;
}

/** Committed changes between the merge base and HEAD: `git diff --name-status -z -M`. */
function committedChanges(root, mb, head, label) {
  const parts = gitOrThrow(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', mb, head], 'git diff').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const status = parts[i][0];
    if (status === 'R' || status === 'C') { out.push({ path: parts[i + 2], reason: `changed since ${label}`, source: 'git-diff' }); i += 2; }
    else { out.push({ path: parts[i + 1], reason: `changed since ${label}`, source: 'git-diff' }); i += 1; }
  }
  return out;
}

/** Paths under the map's own folder, a history folder or a dependency folder are not evidence; they are counted. */
function ignoredPath(p, config) {
  const folders = [config.out, ...config.historyDirs].map((d) => d.replaceAll('\\', '/').replace(/\/+$/, ''));
  return p.split('/').some((s) => SKIP_SEGMENTS.has(s)) || folders.some((d) => p === d || p.startsWith(`${d}/`));
}

function collectChanges(root, config, base) {
  const changes = new Map();
  let ignored = 0;
  const add = (c) => {
    if (ignoredPath(c.path, config)) { ignored++; return; }
    const prior = changes.get(c.path);
    if (!prior) changes.set(c.path, { path: c.path, source: c.source, reasons: [c.reason] });
    else {
      if (!prior.reasons.includes(c.reason)) prior.reasons.push(c.reason);
      if (c.source === 'git-status') prior.source = 'git-status';
    }
  };
  if (base) for (const c of committedChanges(root, base.mergeBase, base.head, base.ref)) add(c);
  for (const c of worktreeChanges(root)) add(c);
  return { changes: [...changes.values()].sort((a, b) => cmp(a.path, b.path)), ignored };
}

const byPathLine = (a, b) => cmp(a.path, b.path) || a.line - b.line;

/** The text rendering: one line per item (id, kind, depth, confidence, reason) and the omissions. */
export function formatPacket(p) {
  const lines = [`context for: ${p.task}`, `${p.budget.estimator}: ~${p.budget.usedTokens} of ${p.budget.maxTokens} tokens · head ${p.freshness.head.slice(0, 8)} · tree ${p.freshness.dirtyHash}`];
  if (p.base) lines.push(`base ${p.base.ref} (${p.base.sha.slice(0, 8)}), merge base ${p.base.mergeBase.slice(0, 8)}`);
  if (!p.items.length) lines.push('', '(no evidence items)');
  for (const i of p.items) lines.push(`  ${i.id}  ${i.kind}${i.depth ? ` d${i.depth}` : ''}  [${i.confidence}] ${i.reason}`);
  if (p.omissions.length) {
    lines.push('', 'omitted:');
    for (const o of p.omissions) lines.push(`  ${o.reason} x${o.count}: ${o.detail}`);
  }
  return lines.join('\n');
}

/**
 * The packet for one task. `store` is the loaded map, `memory` the memory object, `base` an optional ref. Caps
 * are applied in this order and each one is reported in `omissions`: fanout per file, item count, text length,
 * then the whole packet's size (the byte cap, which is what protects the budget when token estimates are off).
 */
export function buildTaskContext({ root, store, memory, task, base, maxTokens = DEFAULT_TOKENS }) {
  const budget = budgetFor(maxTokens);
  if (typeof task !== 'string' || !task.trim()) throw fail('usage', 'a task is required: --task "<text>"');
  if (!store) throw fail('no_map', 'there is no map yet: run map-it-all build');
  const config = loadConfig(root);

  let baseInfo = null;
  if (base !== undefined && base !== null) {
    validateRef(base);
    const baseSha = resolveCommit(root, base);
    const head = resolveCommit(root, 'HEAD');
    const mb = mergeBase(root, baseSha, head);
    baseInfo = { ref: base, sha: baseSha, mergeBase: mb, head };
  }
  const { changes, ignored } = collectChanges(root, config, baseInfo);
  const changedSet = new Set(changes.map((c) => c.path));

  const items = [];
  const omissions = [];
  const seen = new Set();
  const item = (fields) => ({ ...fields, id: evidenceId({ path: fields.path, line: fields.line }) });

  for (const c of changes) {
    seen.add(c.path);
    items.push(item({ kind: 'changed', path: c.path, line: 1, source: c.source, confidence: 'exact', reason: c.reasons.join('; ') }));
    for (const r of store.byPath.get(c.path) ?? []) {
      const line = r.line || 1;
      items.push(item({ kind: 'record', path: c.path, line, source: 'map-records', confidence: 'heuristic', reason: `map record ${r.id} ${flagsOf(r)}` }));
    }
  }

  // Importers: depth 1 for each changed file, then depth 2 through the depth-1 importers (DEPTH_CAP).
  let fanoutCount = 0;
  let fanoutFiles = 0;
  const shownImporters = (target) => {
    const all = [...(store.importedBy.get(target) ?? [])].sort(byPathLine);
    if (all.length > FANOUT_CAP) { fanoutCount += all.length - FANOUT_CAP; fanoutFiles++; }
    return all.slice(0, FANOUT_CAP);
  };
  const origin = new Map(); // depth-1 importer path -> the changed file it imports
  const direct = new Set();
  for (const c of changes) {
    for (const imp of shownImporters(c.path)) {
      if (seen.has(imp.path)) continue;
      seen.add(imp.path);
      direct.add(imp.path);
      origin.set(imp.path, c.path);
      items.push(item({ kind: 'importer', path: imp.path, line: imp.line, depth: 1, source: 'map-importers', confidence: 'heuristic', reason: `imports ${c.path}` }));
    }
  }
  if (DEPTH_CAP >= 2) {
    for (const mid of [...direct].sort(cmp)) {
      for (const imp of shownImporters(mid)) {
        if (seen.has(imp.path)) continue;
        seen.add(imp.path);
        items.push(item({ kind: 'importer', path: imp.path, line: imp.line, depth: 2, source: 'map-importers', confidence: 'heuristic', reason: `imports ${mid}, which imports the changed ${origin.get(mid)} (depth 2)` }));
      }
    }
  }
  if (fanoutCount) omissions.push({ reason: 'fanout_capped', count: fanoutCount, detail: `importers beyond ${FANOUT_CAP} per file were not shown (${fanoutFiles} file(s))` });

  // Memory: a note is proof only when it is fresh and nothing it describes is touched by this change. A note on
  // a changed file, or on a direct importer of one, is a lead even when its own bytes did not change.
  const directSet = new Set(direct);
  let unanchored = 0;
  for (const n of memory?.recall({ query: task, limit: 8 }) ?? []) {
    const anchors = (n.anchors ?? []).map((a) => a.path);
    if (!anchors.length) { unanchored++; continue; }
    const changedAnchor = anchors.find((p) => changedSet.has(p));
    const directAnchor = anchors.find((p) => directSet.has(p));
    const problems = (n.anchorStates ?? []).map((s) => s.detail ?? `${s.path} ${s.state === 'missing' ? 'no longer exists' : 'changed since this note was written'}`);
    let kind = 'memory-verified';
    let reason = 'fresh note: its anchors match the working tree';
    let path = anchors[0];
    if (changedAnchor) { kind = 'memory-lead'; path = changedAnchor; reason = `anchored to ${changedAnchor}, which this change touches; verify before relying on it`; }
    else if (directAnchor) { kind = 'memory-lead'; path = directAnchor; reason = `anchored to ${directAnchor}, which imports a changed file; verify before relying on it`; }
    else if (n.status !== 'fresh') { kind = 'memory-lead'; reason = `note is ${n.status}: ${problems.join('; ') || 'a dependency changed'}; verify before relying on it`; }
    items.push(item({ kind, path, line: 1, source: 'memory', confidence: kind === 'memory-verified' ? 'validated' : 'heuristic', reason, text: `${n.title}: ${n.body}` }));
  }
  if (unanchored) omissions.push({ reason: 'memory_unanchored', count: unanchored, detail: 'notes with no file anchor have no evidence location and are not shown' });
  if (ignored) omissions.push({ reason: 'ignored_path', count: ignored, detail: 'changed paths under the map folder, a history folder or node_modules are not listed' });

  items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.depth ?? 0) - (b.depth ?? 0) || cmp(a.path, b.path) || a.line - b.line);
  const countCapped = capItems(items);
  const textCapped = capItemTexts(countCapped.items);
  const allOmissions = [...omissions, ...countCapped.omissions, ...textCapped.omissions];

  const fp = fingerprint(root);
  const freshness = { head: fp.head, branch: fp.branch, dirtyHash: fp.dirtyHash, mapGenerator: store.stamp?.generator ?? null };
  const taskText = capText(task.trim(), TASK_CHARS).text;
  const byteCap = { reason: 'byte_cap', count: 0, detail: `the packet is over ${budget.maxChars} chars; the lowest-ranked items were dropped` };
  const omissionList = () => (byteCap.count ? [...allOmissions, byteCap] : allOmissions);
  const assemble = (list) => ({
    schemaVersion: 1,
    kind: 'pratzystack.context',
    task: taskText,
    base: baseInfo ? { ref: baseInfo.ref, sha: baseInfo.sha, mergeBase: baseInfo.mergeBase } : null,
    freshness,
    budget: { estimator: ESTIMATOR, maxTokens: budget.maxTokens, usedTokens: 0, hardCapTokens: HARD_CAP_TOKENS },
    items: list,
    omissions: omissionList(),
    usage: { modelCalls: 0 },
  });

  let list = textCapped.items;
  while (list.length && JSON.stringify(assemble(list)).length > budget.maxChars - RESERVE_CHARS) {
    list = list.slice(0, -1);
    byteCap.count++;
  }
  const bare = assemble(list);
  const usedTokens = estimateTokens(JSON.stringify(bare));
  return { ...bare, budget: { ...bare.budget, usedTokens } };
}
