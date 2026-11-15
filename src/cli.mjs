// map-it-all command line. One tool, one map; the MCP server and the CLI share the same code.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBrief, readFilesList } from './brief.mjs';
import { buildMap, check, diff, isFresh, outDirFor, snapshot } from './build.mjs';
import { loadConfig } from './config.mjs';
import { PKG_ROOT } from './context.mjs';
import { doctor } from './doctor.mjs';
import { createMemory, formatHandoff, formatNote } from './memory.mjs';
import { PROFILES, createServer, serveStdio } from './mcp.mjs';
import { findRecords, loadStore } from './store.mjs';
import { renderView } from './view.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs').replaceAll('\\', '/');
const VALUE_FLAGS = ['root', 'out', 'kind', 'flag', 'limit', 'agent', 'profile', 'direction', 'depth'];

function parse(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && VALUE_FLAGS.includes(key)) { opts.flags[key] = next; i++; } else opts.flags[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

export const REPO_SPEC = 'github:peterish8/map-it-all';
const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

const COMMANDS = [
  ['demo', '[--open]', 'try it in 10 seconds on a bundled sample project (nothing in your repo is touched)'],
  ['init', '[--agent claude|cursor|vscode|codex|all] [--npx] [--write]', 'print (or write) the MCP config and the session-start hook'],
  ['doctor', '', 'check Node, git, ast-grep, Knip, RTK and the map'],
  ['build', '[--with-knip]', 'build the map (a few seconds)'],
  ['view', '[--open] [--embed]', 'build and print the path of the zoomable map page'],
  ['brief', '', 'session brief: git, stack, layout, hotspots, leads, handoff, memory'],
  ['query', '<text> [--kind k] [--flag f] [--limit n]', 'find routes, functions, modules, docs, scripts…'],
  ['file', '<path>', 'everything known about one file: records, importers, imports, notes'],
  ['connections', '<file|record> [--direction in|out|both] [--depth n] [--mermaid]', 'blast radius: who depends on it, what it depends on, who calls it'],
  ['leads', '[--kind k] [--flag f] [--public] [--limit n]', 'cleanup candidates (leads, never proof)'],
  ['symbol', '<name>', 'where an identifier is declared and mentioned (name-based)'],
  ['diff', '', 'what this session newly orphaned'],
  ['check', '', "exit 1 if a pack's rules drifted from plain regex counts (for CI)"],
  ['session-start', '', 'rebuild if stale, snapshot, print the brief (a SessionStart hook)'],
  ['snapshot', '', 'save the baseline `diff` compares against'],
  ['ensure', '', 'rebuild only if HEAD or the working tree changed'],
  ['memory', 'list | recall <query> | forget <id>', 'inspect project memory'],
  ['handoff', '', 'print the saved session handoff'],
  ['tokens', '', 'measure the token cost of each MCP tool profile'],
  ['mcp', '[--profile minimal|standard|full]', 'run the MCP server on stdio'],
];

const HELP = `map-it-all ${VERSION}: one local map of your codebase for AI coding agents

usage: map-it-all <command> [options]

commands:
${COMMANDS.map(([name, args, desc]) => `  ${`${name} ${args}`.trim().padEnd(58)}${desc}`).join('\n')}

options:
  --root <dir>    project to map (default: $MAP_IT_ALL_ROOT, then the current directory)
  --out <dir>     where the map lives (default: .map-it-all in the project)
  -v, --version   print the version
  -h, --help      this help; \`map-it-all <command> --help\` for one command

docs: https://github.com/peterish8/map-it-all#readme`;

function commandHelp(name) {
  const c = COMMANDS.find(([n]) => n === name);
  return c ? `map-it-all ${`${c[0]} ${c[1]}`.trim()}\n\n  ${c[2]}\n\nSee https://github.com/peterish8/map-it-all#readme` : HELP;
}

async function ensure(root, out) {
  if (!isFresh(root, out)) await buildMap({ root, out });
}

/**
 * The MCP server entry. Default points at this clone (`node <clone>/bin/...`). With --npx it uses
 * `npx -y github:...` so nothing has to be cloned; on native Windows npx must be run through cmd.
 */
function mcpEntry(root, profile, npx) {
  const tail = ['mcp', ...(npx ? [] : ['--root', root.replaceAll('\\', '/')]), ...(profile ? ['--profile', profile] : [])];
  if (!npx) return { command: 'node', args: [BIN, ...tail] };
  const args = ['-y', REPO_SPEC, ...tail];
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

function mergeJson(file, key, name, entry) {
  let json = {};
  if (existsSync(file)) { try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it or add the server by hand`); } }
  json[key] = { ...json[key], [name]: entry };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function init(root, flags) {
  const config = loadConfig(root);
  const agent = flags.agent === true || !flags.agent ? 'claude' : flags.agent;
  const npx = Boolean(flags.npx);
  const entry = mcpEntry(root, flags.profile && flags.profile !== true ? flags.profile : undefined, npx);
  const out = [];
  const targets = {
    claude: { file: path.join(root, '.mcp.json'), key: 'mcpServers' },
    cursor: { file: path.join(root, '.cursor', 'mcp.json'), key: 'mcpServers' },
    vscode: { file: path.join(root, '.vscode', 'mcp.json'), key: 'servers' },
  };
  for (const name of agent === 'all' ? ['claude', 'cursor', 'vscode', 'codex'] : [agent]) {
    if (name === 'codex') {
      out.push('Codex (~/.codex/config.toml):', '', '[mcp_servers.map-it-all]', `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`, '');
      continue;
    }
    const t = targets[name];
    if (!t) { out.push(`unknown agent "${name}" (use claude, cursor, vscode, codex or all)`); continue; }
    if (flags.write) { mergeJson(t.file, t.key, 'map-it-all', entry); out.push(`wrote ${path.relative(root, t.file)}`); }
    else out.push(`${name} (${path.relative(root, t.file)}):`, JSON.stringify({ [t.key]: { 'map-it-all': entry } }, null, 2), '');
  }
  const gi = path.join(root, '.gitignore');
  const ignored = existsSync(gi) && readFileSync(gi, 'utf8').split('\n').some((l) => l.trim().replace(/^\//, '').startsWith(config.out));
  if (!ignored) {
    if (flags.write) { writeFileSync(gi, `${existsSync(gi) ? `${readFileSync(gi, 'utf8').replace(/\n*$/, '\n')}` : ''}${config.out}/\n`); out.push(`added ${config.out}/ to .gitignore`); }
    else out.push(`add ${config.out}/ to .gitignore (map, memory and handoff are local), or run init --write`);
  }
  out.push(
    '',
    'Claude Code SessionStart hook (.claude/settings.json), so every session starts with the brief:',
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: npx ? `npx -y ${REPO_SPEC} session-start` : `node ${BIN} session-start --root ${root.replaceAll('\\', '/')}`, timeout: 120000 }] }] } }, null, 2),
    '',
    'CLAUDE.md / AGENTS.md lines worth adding:',
    '  - Start each session with the map-it-all `brief` tool. Before editing or deleting, use `connections` and `find`.',
    '  - Zero refs is a lead, never proof. `public` records may be used by installed clients: VERIFY, do not remove.',
    '  - Save durable learnings with the `memory` tool, anchored to files; call `handoff` before ending.',
    '',
    'Optional: pair with RTK to cut shell-output tokens (`map-it-all doctor` shows how).',
  );
  return out.join('\n');
}

function tokens(root, out, config) {
  const lines = ['MCP tool-definition cost (estimated as characters / 4; paid on every request while connected):', ''];
  const server = createServer({ root, profile: 'full' });
  const size = (ts) => Math.round(JSON.stringify(ts.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length / 4);
  for (const profile of Object.keys(PROFILES)) {
    const ts = server.allTools.filter((t) => PROFILES[profile].includes(t.name));
    lines.push(`  ${profile.padEnd(9)} ${String(ts.length).padStart(2)} tools  ~${size(ts)} tokens`);
  }
  lines.push('', 'Per tool:');
  for (const t of server.allTools) lines.push(`  ${t.name.padEnd(12)} ~${size([t])} tokens`);
  const store = existsSync(path.join(out, 'stamp.json')) ? loadStore(out) : null;
  if (store) {
    const brief = renderBrief({ root, store, memory: createMemory({ root, dir: path.join(out, 'memory') }), files: readFilesList(out), hidden: config.historyDirs });
    lines.push('', `Session brief for this project: ${brief.length} chars, ~${Math.round(brief.length / 4)} tokens.`);
  }
  return lines.join('\n');
}

export async function main(argv) {
  const { _: [cmd = 'help', ...rest], flags } = parse(argv);
  if (flags.version || cmd === '-v' || cmd === 'version') { console.log(VERSION); return; }
  if (cmd === '-h') { console.log(HELP); return; }
  if (flags.help) { console.log(commandHelp(cmd === 'help' ? rest[0] : cmd)); return; }
  const demo = cmd === 'demo';
  const root = demo ? path.join(PKG_ROOT, 'examples', 'demo-app')
    : path.resolve(flags.root === true || !flags.root ? process.env.MAP_IT_ALL_ROOT || process.cwd() : flags.root);
  const config = loadConfig(root);
  const out = demo ? path.join(tmpdir(), 'map-it-all-demo')
    : path.resolve(flags.out === true || !flags.out ? outDirFor(root, config) : flags.out);
  const memDir = config.memoryDir ? path.resolve(root, config.memoryDir) : path.join(out, 'memory');
  const log = (m) => console.log(m);

  switch (cmd) {
    case 'help': console.log(commandHelp(rest[0])); break;
    case 'demo': {
      // A bundled sample project, mapped into the OS temp folder: nothing in your repo is touched.
      rmSync(out, { recursive: true, force: true });
      const built = await buildMap({ root, out });
      console.log(renderBrief({ root, store: loadStore(out), memory: createMemory({ root, dir: memDir }), files: readFilesList(out), hidden: config.historyDirs, showGit: false }));
      console.log(`\nDemo map built in ${built.stamp.ms} ms from ${path.relative(process.cwd(), root) || root}.\nZoomable map: ${path.join(out, 'graph.html')}\nTry it on your project: map-it-all init, then map-it-all build`);
      const broken = built.stamp.errors.filter((e) => !e.soft);
      if (broken.length) { console.error(`\ndemo map is incomplete:\n${broken.map((e) => `  ${e.extractor}: ${e.message}`).join('\n')}\nRun: map-it-all doctor`); process.exit(1); }
      if (flags.open) {
        const file = path.join(out, 'graph.html');
        const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [file]];
        spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
      }
      break;
    }
    case 'init': console.log(init(root, flags)); break;
    case 'doctor': { const r = doctor(root); console.log(r.text); if (!r.ok) process.exit(1); break; }
    case 'build': {
      log(`map-it-all: ${root}`);
      const { stamp } = await buildMap({ root, out, withKnip: Boolean(flags['with-knip']), log });
      log(`done in ${stamp.ms} ms: ${stamp.files} files, packs: ${Object.keys(stamp.packs).join(', ') || 'none'} -> ${path.relative(process.cwd(), out) || out}/INDEX.md`);
      for (const e of stamp.errors) log(`  ! ${e.extractor}: ${e.message}`);
      break;
    }
    case 'view': {
      const built = await buildMap({ root, out });
      let file = path.join(out, 'graph.html');
      if (flags.embed) {
        file = path.join(out, 'graph.embed.html');
        writeFileSync(file, renderView({ root, stamp: built.stamp, results: built.results, files: built.files, hidden: config.historyDirs, embed: true }));
      }
      console.log(file);
      if (flags.open) {
        const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [file]];
        spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
      }
      break;
    }
    case 'brief': {
      await ensure(root, out);
      console.log(renderBrief({ root, store: loadStore(out), memory: createMemory({ root, dir: memDir }), files: readFilesList(out), hidden: config.historyDirs }));
      break;
    }
    case 'session-start': {
      await ensure(root, out);
      snapshot(out);
      console.log(renderBrief({ root, store: loadStore(out), memory: createMemory({ root, dir: memDir }), files: readFilesList(out), hidden: config.historyDirs }));
      break;
    }
    case 'ensure': await ensure(root, out); log('map fresh'); break;
    case 'snapshot': await ensure(root, out); snapshot(out); log('baseline saved'); break;
    case 'diff': await ensure(root, out); console.log(diff(out)); break;
    case 'query': {
      await ensure(root, out);
      console.log(findRecords(loadStore(out), { query: rest.join(' '), kind: flags.kind === true ? undefined : flags.kind, flag: flags.flag === true ? undefined : flags.flag, limit: Number(flags.limit ?? 25) }));
      break;
    }
    case 'file': case 'connections': case 'leads': case 'symbol': {
      // The same code the MCP tools run, so the terminal and the agent always agree.
      await ensure(root, out);
      const str = (v) => (v === true ? undefined : v);
      const args = {
        file: { path: rest.join(' ') },
        connections: { target: rest.join(' '), direction: str(flags.direction), depth: flags.depth ? Number(flags.depth) : undefined, format: flags.mermaid ? 'mermaid' : undefined },
        leads: { kind: str(flags.kind), flag: str(flags.flag), public: flags.public ? true : undefined, limit: flags.limit ? Number(flags.limit) : undefined },
        symbol: { name: rest[0] ?? '', limit: flags.limit ? Number(flags.limit) : undefined },
      }[cmd];
      if ((cmd === 'file' || cmd === 'connections' || cmd === 'symbol') && !rest.length) { console.error(commandHelp(cmd)); process.exit(2); }
      const tool = createServer({ root, profile: 'full', outOverride: out }).allTools.find((t) => t.name === cmd);
      console.log(await tool.run(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))));
      break;
    }
    case 'check': {
      const { stamp } = await buildMap({ root, write: false });
      const problems = check(stamp);
      if (problems.length) { console.error(`check failed\n- ${problems.join('\n- ')}`); process.exit(1); }
      console.log(`check ok${stamp.checks.length ? ` (${stamp.checks.map((c) => `${c.name} ${c.found}/${c.expected}`).join(', ')})` : ''}`);
      break;
    }
    case 'memory': {
      const memory = createMemory({ root, dir: memDir });
      const [sub = 'list', ...args] = rest;
      if (sub === 'list') { const l = memory.list(); console.log(l.length ? l.map((n) => `${n.id}  [${n.kind}] ${n.status}  ${n.title}`).join('\n') : 'No notes yet.'); }
      else if (sub === 'recall') { const l = memory.recall({ query: args.join(' ') }); console.log(l.length ? l.map(formatNote).join('\n\n') : 'No matching notes.'); }
      else if (sub === 'forget') console.log(memory.forget(args[0] ?? '') ? `forgot ${args[0]}` : 'no such note');
      else console.log('usage: memory list | recall <query> | forget <id>');
      break;
    }
    case 'handoff': console.log(formatHandoff(createMemory({ root, dir: memDir }).readHandoff())); break;
    case 'tokens': console.log(tokens(root, out, config)); break;
    case 'mcp': serveStdio({ root, profile: flags.profile === true ? 'standard' : flags.profile ?? 'standard', outOverride: flags.out === true ? undefined : flags.out }); return;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
      break;
  }
}
