// `map-it-all init` and `map-it-all uninstall`: one command to set a project up, one to take it back out.
//
// init: builds the map (and its connections), writes the MCP config for your agent, appends a short
// instruction block to the end of CLAUDE.md and AGENTS.md, and ignores the local map folder in git.
// Everything is idempotent: run it again and it updates in place instead of duplicating.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap, outDirFor } from './build.mjs';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { setEnabled } from './realtime.mjs';
import { loadStore } from './store.mjs';

export const REPO_SPEC = 'github:peterish8/map-it-all';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs').replaceAll('\\', '/');

export const BLOCK_START = '<!-- map-it-all:start -->';
export const BLOCK_END = '<!-- map-it-all:end -->';
const BLOCK_RE = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);

// ---------- the instruction block ----------

export function blockText(outDir = '.map-it-all') {
  return [
    BLOCK_START,
    '## Code map (map-it-all)',
    '',
    `This project is mapped by [map-it-all](https://github.com/peterish8/map-it-all). The map, memory notes and handoff live in \`${outDir}/\` (local, gitignored). Rebuild with \`map-it-all build\`.`,
    '',
    '- Start each session with the map-it-all `brief` tool. Before editing or deleting, use `connections` and `find`.',
    '- Zero refs is a lead, never proof. `public` records may be used by installed clients: VERIFY, do not remove.',
    '- Save durable learnings with the `memory` tool, anchored to files; call `handoff` before ending.',
    BLOCK_END,
  ].join('\n');
}

/**
 * Append the block to the very end of a Markdown file (creating the file if needed), or replace an
 * existing block in place. Keeps the file's own line endings. Returns what happened.
 */
export function applyBlock(file, block) {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = block.replaceAll('\n', eol);
  if (BLOCK_RE.test(text)) {
    const next = text.replace(BLOCK_RE, () => body);
    if (next === text) return 'unchanged';
    writeFileSync(file, next);
    return 'updated';
  }
  const kept = text.replace(/\s+$/, '');
  writeFileSync(file, kept ? `${kept}${eol}${eol}${body}${eol}` : `${body}${eol}`);
  return exists ? 'appended' : 'created';
}

/** Remove the block (and the blank line before it). Deletes the file if nothing else is left. */
export function removeBlock(file) {
  if (!existsSync(file)) return 'missing';
  const text = readFileSync(file, 'utf8');
  if (!BLOCK_RE.test(text)) return 'none';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = text.replace(new RegExp(`(?:\\r?\\n){0,2}${BLOCK_START}[\\s\\S]*?${BLOCK_END}(?:\\r?\\n)?`), () => '').replace(/\s+$/, '');
  if (!next) { unlinkSync(file); return 'deleted'; }
  writeFileSync(file, `${next}${eol}`);
  return 'removed';
}

const sameFile = (a, b) => {
  try { return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b); } catch { return false; }
};

// ---------- MCP config, hook, gitignore ----------

/**
 * The MCP server entry. Default points at this clone (`node <clone>/bin/...`). With --npx it uses
 * `npx -y github:...` so nothing has to be cloned; on native Windows npx must be run through cmd.
 */
export function mcpEntry(root, profile, npx) {
  const tail = ['mcp', ...(npx ? [] : ['--root', root.replaceAll('\\', '/')]), ...(profile ? ['--profile', profile] : [])];
  if (!npx) return { command: 'node', args: [BIN, ...tail] };
  const args = ['-y', REPO_SPEC, ...tail];
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

const targetsFor = (root) => ({
  claude: { file: path.join(root, '.mcp.json'), key: 'mcpServers' },
  cursor: { file: path.join(root, '.cursor', 'mcp.json'), key: 'mcpServers' },
  vscode: { file: path.join(root, '.vscode', 'mcp.json'), key: 'servers' },
});

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it or add the server by hand`); }
}

function writeJson(file, json) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function mergeServer(file, key, name, entry) {
  const json = readJson(file);
  const before = JSON.stringify(json[key]?.[name]);
  json[key] = { ...json[key], [name]: entry };
  if (before === JSON.stringify(entry)) return 'unchanged';
  writeJson(file, json);
  return before === undefined ? 'added' : 'updated';
}

function removeServer(file, key, name) {
  if (!existsSync(file)) return 'missing';
  const json = readJson(file);
  if (!json[key]?.[name]) return 'none';
  delete json[key][name];
  if (!Object.keys(json[key]).length) delete json[key];
  if (!Object.keys(json).length) unlinkSync(file); else writeJson(file, json);
  return 'removed';
}

// The two hooks map-it-all installs: SessionStart (the brief) and PostToolUse on edits (realtime).
const isSessionCmd = (c) => typeof c === 'string' && c.includes('map-it-all') && c.includes('session-start');
const isTouchCmd = (c) => typeof c === 'string' && c.includes('map-it-all') && /\stouch\b/.test(c);
const HOOK_EVENTS = [['SessionStart', isSessionCmd], ['PostToolUse', isTouchCmd]];

export const touchCommand = () => `node "${BIN}" touch`;

function mergeHooks(file, sessionCommand) {
  const json = readJson(file);
  json.hooks ??= {};
  const wanted = {
    SessionStart: { hooks: [{ type: 'command', command: sessionCommand, timeout: 120000 }] },
    PostToolUse: { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: touchCommand(), timeout: 10 }] },
  };
  let changed = false;
  for (const [event, ours] of HOOK_EVENTS) {
    const groups = json.hooks[event] ?? [];
    const want = wanted[event];
    if (groups.some((g) => g.matcher === want.matcher && g.hooks?.some((h) => h.command === want.hooks[0].command))) continue;
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command)) })).filter((g) => g.hooks.length);
    json.hooks[event] = [...kept, want];
    changed = true;
  }
  if (changed) writeJson(file, json);
  return changed ? 'added' : 'unchanged';
}

function removeHooks(file) {
  if (!existsSync(file)) return 'missing';
  const json = readJson(file);
  let removed = false;
  for (const [event, ours] of HOOK_EVENTS) {
    const groups = json.hooks?.[event];
    if (!groups?.some((g) => g.hooks?.some((h) => ours(h.command)))) continue;
    json.hooks[event] = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !ours(h.command)) })).filter((g) => g.hooks.length);
    if (!json.hooks[event].length) delete json.hooks[event];
    removed = true;
  }
  if (!removed) return 'none';
  if (!Object.keys(json.hooks).length) delete json.hooks;
  if (!Object.keys(json).length) unlinkSync(file); else writeJson(file, json);
  return 'removed';
}

/** Is the realtime (PostToolUse) hook present in this project's Claude Code settings? */
export function hookInstalled(root) {
  try {
    return (readJson(path.join(root, '.claude', 'settings.json')).hooks?.PostToolUse ?? []).some((g) => g.hooks?.some((h) => isTouchCmd(h.command)));
  } catch { return false; }
}

function ensureIgnored(root, outName, dry) {
  const gi = path.join(root, '.gitignore');
  const text = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (text.split(/\r?\n/).some((l) => l.trim().replace(/^\//, '').replace(/\/$/, '') === outName)) return 'already ignored';
  if (dry) return 'would add';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(gi, `${text ? `${text.replace(/\s+$/, '')}${eol}` : ''}${outName}/${eol}`);
  return 'added';
}

// ---------- init ----------

export async function runInit(root, flags) {
  const dry = Boolean(flags['dry-run']);
  const config = loadConfig(root);
  const npx = Boolean(flags.npx);
  const self = npx ? `npx -y ${REPO_SPEC}` : `node ${BIN}`;
  const agent = flags.agent === true || !flags.agent ? 'claude' : flags.agent;
  const profile = flags.profile && flags.profile !== true ? flags.profile : undefined;
  const entry = mcpEntry(root, profile, npx);
  const out = [`map-it-all: setting up ${root}${dry ? '  (dry run: nothing is written)' : ''}`, ''];
  const warnings = [];

  // 1. the map and its connections
  if (dry || flags['no-build']) out.push(`[1/4] Map             ${dry ? 'would build' : 'skipped (--no-build)'}: ${path.relative(root, outDirFor(root, config)) || config.out}/`);
  else {
    const { stamp } = await buildMap({ root });
    const store = loadStore(outDirFor(root, config));
    const edges = [...store.importedBy.values()].reduce((n, l) => n + l.length, 0);
    const hubs = [...store.importedBy].map(([f, l]) => [f, new Set(l.map((i) => i.path)).size]).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const packs = Object.keys(stamp.packs);
    out.push(`[1/4] Map             built in ${(stamp.ms / 1000).toFixed(1)} s: ${stamp.files} files, packs: ${packs.join(', ') || 'none detected (generic checks only)'}`);
    out.push(`                      connections: ${edges} import edges across ${store.importedBy.size} imported files${hubs.length ? `; most imported: ${hubs.map(([f, n]) => `${f} (x${n})`).join(', ')}` : ''}`);
    const leads = store.records.filter((r) => !r.history && r.flags.some((f) => ['no-refs', 'test-only', 'unmounted', 'dead-path'].includes(f))).length;
    out.push(`                      ${store.records.filter((r) => r.public).length} public records (verify, never remove), ${leads} cleanup leads`);
    for (const e of stamp.errors.filter((x) => !x.soft)) warnings.push(`${e.extractor} failed: ${e.message.slice(0, 140)}`);
  }

  // 2. MCP config
  const targets = targetsFor(root);
  const names = agent === 'all' ? ['claude', 'cursor', 'vscode', 'codex'] : String(agent).split(',');
  const results = [];
  for (const name of names) {
    if (name === 'codex') { results.push({ name, note: 'printed below (Codex keeps its config in your home folder)' }); continue; }
    const t = targets[name];
    if (!t) { warnings.push(`unknown agent "${name}" (use claude, cursor, vscode, codex or all)`); continue; }
    const rel = path.relative(root, t.file);
    results.push({ name, note: dry ? `would write ${rel}` : `${mergeServer(t.file, t.key, 'map-it-all', entry)} in ${rel}` });
  }
  out.push(`[2/4] MCP config      ${results.map((r) => `${r.name}: ${r.note}`).join('; ') || 'nothing to write'}`);

  // 3. CLAUDE.md and AGENTS.md
  if (flags['no-docs']) out.push('[3/4] Instructions    skipped (--no-docs)');
  else {
    const which = flags.docs === true || !flags.docs || flags.docs === 'both' ? ['CLAUDE.md', 'AGENTS.md'] : flags.docs === 'agents' ? ['AGENTS.md'] : ['CLAUDE.md'];
    const done = [];
    const written = [];
    for (const name of which) {
      const file = path.join(root, name);
      const twin = written.find((w) => sameFile(w, file));
      if (twin) { done.push(`${name}: same file as ${path.basename(twin)}`); continue; }
      done.push(`${name}: ${dry ? (existsSync(file) ? (BLOCK_RE.test(readFileSync(file, 'utf8')) ? 'would update the block' : 'would append the block') : 'would create') : applyBlock(file, blockText(config.out))}`);
      written.push(file);
    }
    out.push(`[3/4] Instructions    ${done.join('; ')}`);
  }

  // 4. .gitignore
  out.push(`[4/4] .gitignore      ${config.out}/ ${ensureIgnored(root, config.out, dry)}`);

  // optional: persist the network opt-in. Only this explicit flag ever writes it; plain init stays offline.
  if (flags.online) {
    const file = path.join(root, CONFIG_FILE);
    let note;
    if (dry) note = `would set "network": true in ${CONFIG_FILE}`;
    else {
      const json = readJson(file);
      note = json.network === true ? 'already set' : 'set';
      if (note === 'set') writeJson(file, { ...json, network: true });
    }
    out.push('', `Network              ${note} ("network": true in ${CONFIG_FILE}). deps and docs may now look up advisories and docs. OSV receives package/version queries and advisory IDs; npm/docs receive requested URLs and ordinary HTTP/TLS metadata. Undo: set it to false, or use MAP_IT_ALL_OFFLINE=1.`);
  }

  // optional hooks: the brief at session start, and realtime updates after each edit
  if (flags.hook) {
    const hookFile = path.join(root, '.claude', 'settings.json');
    const sessionCommand = npx ? `npx -y ${REPO_SPEC} session-start` : `node ${BIN} session-start --root ${root.replaceAll('\\', '/')}`;
    out.push('', `Hooks                ${dry ? 'would write' : mergeHooks(hookFile, sessionCommand)} in ${path.relative(root, hookFile)} (SessionStart brief + realtime after edits)`);
    if (!dry) { setEnabled(outDirFor(root, config), true); out.push('Realtime             ON. Switch it with `realtime off` / `realtime on`, or let Claude call the realtime tool.'); }
  }
  if (names.includes('codex')) {
    out.push('', 'Codex (~/.codex/config.toml):', '', '[mcp_servers.map-it-all]', `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`);
  }
  for (const w of warnings) out.push('', `! ${w}`);

  out.push('', 'Next:',
    '  1. Restart your agent in this project. Claude Code asks you to approve the project-level "map-it-all" server once.',
    '  2. Ask it: "call the map-it-all brief tool".',
    ...(flags.hook ? [] : [`  3. Optional: start every session with the brief and keep the map fresh as the agent edits: ${self} init --hook`]),
    `  Check anything with: ${self} doctor    ·    undo everything with: ${self} uninstall`);
  return out.join('\n');
}

// ---------- uninstall ----------

export async function runUninstall(root, flags) {
  const config = loadConfig(root);
  const out = [`map-it-all: removing from ${root}`, ''];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) out.push(`${name.padEnd(20)} instruction block: ${removeBlock(path.join(root, name))}`);
  const targets = targetsFor(root);
  for (const [name, t] of Object.entries(targets)) out.push(`${path.relative(root, t.file).padEnd(20)} map-it-all server: ${removeServer(t.file, t.key, 'map-it-all')}`);
  out.push(`${'.claude/settings.json'.padEnd(20)} map-it-all hooks: ${removeHooks(path.join(root, '.claude', 'settings.json'))}`);
  const outDir = outDirFor(root, config);
  const inside = path.relative(root, outDir);
  if (flags.purge) {
    // Never delete outside the project, or the project root itself, whatever the config says.
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) out.push(`${(config.out + '/').padEnd(20)} NOT deleted: "${config.out}" is not a folder inside the project`);
    else {
      rmSync(outDir, { recursive: true, force: true });
      out.push(`${(config.out + '/').padEnd(20)} deleted (map, memory notes, handoff)`);
    }
  } else out.push(`${(config.out + '/').padEnd(20)} kept (your memory notes and handoff live here); delete it with --purge`);
  out.push('', 'The .gitignore line was left alone. Codex config, if you added one, lives in ~/.codex/config.toml.');
  return out.join('\n');
}
