// map-it-all command line. One tool, one map; the MCP server and the CLI share the same code.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderBrief, readFilesList } from './brief.mjs';
import { buildMap, check, diff, isFresh, outDirFor, snapshot } from './build.mjs';
import { loadConfig } from './config.mjs';
import { PKG_ROOT } from './context.mjs';
import { doctor } from './doctor.mjs';
import { hookInstalled, runInit, runUninstall } from './init.mjs';
import { createMemory, formatHandoff, formatNote } from './memory.mjs';
import { PROFILES, createServer, serveStdio } from './mcp.mjs';
import { runWorker, setEnabled, status as realtimeStatus } from './realtime.mjs';
import { findRecords, loadStore } from './store.mjs';
import { renderView } from './view.mjs';

const VALUE_FLAGS = ['root', 'out', 'kind', 'flag', 'limit', 'agent', 'profile', 'direction', 'depth', 'docs'];

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

const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

const COMMANDS = [
  ['demo', '[--open]', 'try it in 10 seconds on a bundled sample project (nothing in your repo is touched)'],
  ['init', '[--agent claude|cursor|vscode|codex|all] [--npx] [--hook] [--dry-run]', 'set the project up: build the map, write the MCP config, add the block to CLAUDE.md and AGENTS.md'],
  ['uninstall', '[--purge]', 'undo init: remove the instruction blocks, MCP entries and hooks (--purge also deletes the local map and memory)'],
  ['realtime', '[on|off|status]', 'keep the map fresh while an agent edits (needs the hooks from `init --hook`); switch it any time'],
  ['touch', '(hook; reads Claude Code JSON on stdin)', 'after an agent edit: refresh the map in the background and warn about the edited file'],
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
${COMMANDS.map(([name, args, desc]) => `  ${`${name} ${args}`.trim().padEnd(76)}${desc}`).join('\n')}

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
    case 'init': console.log(await runInit(root, flags)); break;
    case 'uninstall': console.log(await runUninstall(root, flags)); break;
    case 'realtime': {
      const action = rest[0] ?? 'status';
      if (action !== 'on' && action !== 'off' && action !== 'status') { console.error(commandHelp('realtime')); process.exit(2); }
      if (action !== 'status') setEnabled(out, action === 'on');
      const s = realtimeStatus(out);
      console.log(`realtime: ${s.enabled ? 'ON' : 'OFF'}${s.rebuilding ? '  (a background rebuild is running)' : ''}`);
      if (s.enabled && !hookInstalled(root)) console.log('note: the edit hook is not installed in this project, so nothing triggers it yet. Run: map-it-all init --hook');
      break;
    }
    case 'rebuild-worker': await runWorker({ root, out, debounceMs: Number(process.env.MAP_IT_ALL_DEBOUNCE_MS) || 1500 }); break;
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
