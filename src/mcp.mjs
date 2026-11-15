// MAP-IT-ALL as a local MCP server (stdio, zero dependencies).
//
//   map-it-all mcp [--root <repo>] [--profile minimal|standard|full]
//
// Newline-delimited JSON-RPC 2.0. Only protocol messages go to stdout; diagnostics go to stderr.
// The map rebuilds itself when HEAD or the working tree changed. Nothing leaves the machine.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderBrief, readFilesList } from './brief.mjs';
import { buildMap, diff, isFresh, outDirFor } from './build.mjs';
import { loadConfig } from './config.mjs';
import { PKG_ROOT, createContext } from './context.mjs';
import { runDeps, versionOfFrom } from './deps.mjs';
import { hookInstalled } from './init.mjs';
import { createMemory, formatHandoff, formatNote } from './memory.mjs';
import { lockHeld, setEnabled, status as realtimeStatus, waitForLock } from './realtime.mjs';
import { findRecords, flagsOf, formatConnections, loadStore, mermaid, resolveTarget, LEAD_FLAGS } from './store.mjs';

const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
const MAX_TEXT = 14000;

export const PROFILES = {
  minimal: ['brief', 'find', 'connections', 'memory'],
  standard: ['brief', 'find', 'file', 'connections', 'leads', 'symbol', 'diff', 'deps', 'memory', 'handoff', 'realtime'],
  full: ['brief', 'find', 'file', 'connections', 'leads', 'symbol', 'diff', 'deps', 'memory', 'handoff', 'realtime', 'refresh', 'view'],
};

const INSTRUCTIONS = [
  'MAP-IT-ALL: a map of this repo (what imports, calls and registers what), a session brief, and file-anchored memory.',
  'Start a session with `brief`. Before editing or deleting, use `connections` (blast radius) and `find`.',
  'Zero refs is a lead, never proof; `public` records may be used by installed clients or external callers: VERIFY, never REMOVE.',
  'Save durable learnings with `memory` (anchor them to files so they are flagged when the code changes) and call `handoff` before ending a session.',
  '`symbol` is name-based; use a language-server or call-graph tool for exact call graphs.',
].join(' ');

export function createServer({ root, profile = 'standard', outOverride, allowOnline = false } = {}) {
  root = path.resolve(root);
  const config = loadConfig(root);
  const out = outOverride ? path.resolve(outOverride) : outDirFor(root, config);
  const memDir = config.memoryDir ? path.resolve(root, config.memoryDir) : path.join(out, 'memory');
  const memory = createMemory({ root, dir: memDir, versionOf: versionOfFrom(() => (existsSync(path.join(out, 'stamp.json')) ? store() : null)) });
  let cache = null;
  let building = null;

  async function ensureFresh({ force = false, withKnip = false } = {}) {
    // A realtime worker may be rebuilding right now: wait for it instead of racing it.
    if (lockHeld(out)) await waitForLock(out);
    if (!force && isFresh(root, out)) return false;
    building ??= buildMap({ root, out, withKnip }).finally(() => { building = null; });
    await building;
    cache = null;
    return true;
  }

  function store() {
    const mtime = statSync(path.join(out, 'stamp.json')).mtimeMs;
    if (!cache || cache.mtime !== mtime) cache = { mtime, store: loadStore(out) };
    return cache.store;
  }

  const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… output clipped; narrow the query or lower limit` : text);

  function resolveOrExplain(s, needle) {
    const t = resolveTarget(s, needle);
    if (!t) return { error: `No file or record matches "${needle}". Try the find tool.` };
    if (t.ambiguous) return { error: `"${needle}" is ambiguous. Candidates:\n${t.ambiguous.map((x) => `  ${x}`).join('\n')}` };
    return t;
  }

  const tools = [
    {
      name: 'brief',
      description: 'Start-of-session briefing in a few hundred tokens: git state, stack, layout, most-imported files, public surface, cleanup leads, last handoff, memory notes. Call this first instead of exploring the repo.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        await ensureFresh();
        return renderBrief({ root, store: store(), memory, files: readFilesList(out), hidden: config.historyDirs });
      },
    },
    {
      name: 'find',
      description: 'Find map records (routes, functions, native modules, scripts, docs…) by id, name or path substring; filter by kind, flag (no-refs, test-only, unmounted, conditional-mount, undocumented, outside-runner-globs, dead-path…) or public.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring of id, name or path. Optional when filtering.' },
          kind: { type: 'string' }, flag: { type: 'string' },
          public: { type: 'boolean', description: 'Only records installed clients or external callers may reach.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      async run(a) { await ensureFresh(); return findRecords(store(), a); },
    },
    {
      name: 'file',
      description: 'Everything known about one file: its records (flags, refs), who imports it, what it imports, debt markers. Accepts a path, a unique path suffix or a record id.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async run(a) {
        await ensureFresh();
        const s = store();
        const t = resolveOrExplain(s, a.path);
        if (t.error) return t.error;
        const recs = s.byPath.get(t.path) ?? [];
        const lines = [t.path];
        const deps = recs.filter((x) => x.kind === 'dependency');
        if (deps.length) lines.push('', `declares ${deps.length} dependencies (use the deps tool for versions, advisories and who imports them)`);
        for (const r of recs.filter((x) => x.kind !== 'debt' && x.kind !== 'dependency')) {
          lines.push('', `${r.id}  line ${r.line}  ${flagsOf(r)}  refs ${r.refCount} (production ${r.prodRefCount})`);
          for (const x of r.refs.slice(0, 8)) lines.push(`    ${x.path}:${x.line} ${x.how}`);
          if (r.refCount > 8) lines.push(`    … ${r.refCount - 8} more (use connections)`);
          if (r.kind === 'doc-drift') lines.push(`    dead paths: ${r.dead.slice(0, 8).map((d) => `${d.ref}:${d.line}`).join(', ')}`);
        }
        const debt = recs.find((x) => x.kind === 'debt');
        if (debt) lines.push('', `debt markers (${debt.total}): ${Object.entries(debt.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        const inn = s.importedBy.get(t.path) ?? [];
        const outt = s.imports.get(t.path) ?? [];
        lines.push('', `imported by (${inn.length}): ${inn.slice(0, 25).map((e) => `${e.path}:${e.line}`).join(', ')}${inn.length > 25 ? ` … +${inn.length - 25}` : ''}`);
        lines.push(`imports (${outt.length}): ${outt.slice(0, 25).join(', ')}${outt.length > 25 ? ` … +${outt.length - 25}` : ''}`);
        const notes = memory.recall({ query: t.path, limit: 3 }).filter((n) => n.anchors.some((x) => x.path === t.path));
        if (notes.length) lines.push('', 'memory notes anchored here:', ...notes.map(formatNote));
        return lines.join('\n');
      },
    },
    {
      name: 'connections',
      description: 'Connections around a file or record: who imports it (blast radius), what it imports, and callers of what it registers (routes, functions, native modules). depth walks the import graph transitively. format "mermaid" returns a diagram to show the user.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'File path, unique path suffix, or record id.' },
          direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both', description: 'in = who depends on it (blast radius), out = what it depends on.' },
          depth: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
          format: { type: 'string', enum: ['text', 'mermaid'], default: 'text' },
          max: { type: 'integer', minimum: 5, maximum: 200, default: 60 },
        },
        required: ['target'],
      },
      async run(a) {
        await ensureFresh();
        const s = store();
        const t = resolveOrExplain(s, a.target);
        if (t.error) return t.error;
        const opts = { direction: a.direction ?? 'both', depth: a.depth ?? 1, max: a.max ?? 60, recordId: t.record?.id };
        const body = a.format === 'mermaid' ? mermaid(s, t.path, opts) : formatConnections(s, t.path, opts);
        return t.record ? `record ${t.record.id} lives in ${t.path}\n\n${body}` : body;
      },
    },
    {
      name: 'leads',
      description: 'Cleanup candidates: no refs, test-only refs, unmounted routes, unregistered native modules, tests outside every runner, docs pointing at missing paths. Leads, not proof; public ones need VERIFY.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string' }, flag: { type: 'string', description: 'One flag; default is every lead flag.' },
          public: { type: 'boolean' }, include_history: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 150, default: 40 },
        },
      },
      async run(a) {
        await ensureFresh();
        const limit = a.limit ?? 40;
        const hits = store().records.filter((r) => (a.kind ? r.kind === a.kind : r.kind !== 'debt' && r.kind !== 'knip')
          && (a.flag ? r.flags.includes(a.flag) : r.flags.some((f) => LEAD_FLAGS.has(f)))
          && (a.public === undefined || Boolean(r.public) === a.public) && (a.include_history || !r.history));
        const by = new Map();
        for (const r of hits) { if (!by.has(r.kind)) by.set(r.kind, []); by.get(r.kind).push(r); }
        const lines = [`${hits.length} lead(s)`];
        let shown = 0;
        for (const [kind, list] of by) {
          lines.push('', `${kind} (${list.length})`);
          for (const r of list) { if (shown++ >= limit) break; lines.push(`  ${r.id}  ${r.path}:${r.line}  ${flagsOf(r)}`); }
        }
        if (hits.length > limit) lines.push('', `… ${hits.length - limit} more; raise limit or filter`);
        return lines.join('\n');
      },
    },
    {
      name: 'symbol',
      description: 'Name-based lookup across TS, JS, Kotlin, Rust, Go and Swift: where an identifier is declared and which files mention it. Not type-aware (same-named symbols elsewhere match).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, required: ['name'] },
      async run(a) {
        if (!/^[A-Za-z_$][\w$]*$/.test(a.name)) return 'name must be a plain identifier.';
        const ctx = createContext(root, config);
        const code = (f) => /\.(tsx?|jsx?|mjs|cjs|kt|rs|go|swift)$/.test(f) && !ctx.isHistory(f);
        const n = a.name.replaceAll('$', '\\$');
        const decl = new RegExp(`\\b(?:function\\*?|class|interface|type|enum|const|let|var|fun|object|val|typealias|fn|struct|trait|static|func)\\s+(?:<[^>]*>\\s*)?${n}\\b`);
        const defs = ctx.grep(decl, code);
        const defKeys = new Set(defs.map((d) => `${d.path}:${d.line}`));
        const refs = ctx.grep(new RegExp(`\\b${n}\\b`), code).filter((r) => !defKeys.has(`${r.path}:${r.line}`));
        ctx.dispose();
        const byFile = new Map();
        for (const r of refs) { if (!byFile.has(r.path)) byFile.set(r.path, []); byFile.get(r.path).push(r.line); }
        const limit = a.limit ?? 25;
        const lines = [`${defs.length} declaration(s), ${refs.length} other mention(s) in ${byFile.size} file(s)  (name-based)`];
        for (const d of defs.slice(0, 10)) lines.push(`  declared ${d.path}:${d.line}`);
        for (const [f, ls] of [...byFile].sort((x, y) => y[1].length - x[1].length).slice(0, limit)) lines.push(`  ${f}  ×${ls.length}  lines ${ls.slice(0, 6).join(',')}${ls.length > 6 ? ',…' : ''}`);
        if (byFile.size > limit) lines.push(`  … ${byFile.size - limit} more files`);
        return lines.join('\n');
      },
    },
    {
      name: 'diff',
      description: 'What this session newly orphaned: records that lost their last production reference since the session-start snapshot, removed records, new surface nothing uses. Needs the snapshot taken at session start.',
      inputSchema: { type: 'object', properties: {} },
      async run() { await ensureFresh(); return diff(out); },
    },
    {
      name: 'deps',
      description: 'Dependencies tied to your code: which files import each package, known vulnerabilities and deprecations for the installed versions with the files they expose, possibly unused packages. package + docs saves a version-pinned docs excerpt as a memory note. Online lookups run only if the user enabled them; results are cached.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'One direct dependency, for detail.' },
          docs: { type: 'string', description: 'With package: what you need to know (a keyword or question) for a short docs excerpt.' },
          only: { type: 'string', enum: ['vulnerable', 'deprecated', 'unused'] },
          refresh: { type: 'boolean', description: 'Re-check now instead of using the cache (only if online is enabled).' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
        },
      },
      async run(a) { await ensureFresh(); return runDeps({ root, out, store: store(), memory, config, args: a, allowOnline }); },
    },
    {
      name: 'memory',
      description: 'Project memory that knows when it is stale. action "remember" saves a note (title, body ≤2000 chars, kind fact|decision|gotcha|todo|preference, tags, anchors = repo-relative files it is about); "recall" searches (flags notes whose anchored files changed or vanished); "confirm" re-verifies a note after you checked it; "forget" deletes; "list" shows all.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remember', 'recall', 'confirm', 'forget', 'list'] },
          title: { type: 'string' }, body: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'decision', 'gotcha', 'todo', 'preference'] },
          tags: { type: 'array', items: { type: 'string' } },
          anchors: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files this note is about.' },
          query: { type: 'string' }, id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
        },
        required: ['action'],
      },
      async run(a) {
        switch (a.action) {
          case 'remember': { const n = memory.remember(a); return `${n.replaced ? 'updated' : 'saved'} ${n.id} (${n.status}${n.anchors.length ? `, anchored to ${n.anchors.length} file(s)` : ', no anchors: it cannot be flagged stale'})`; }
          case 'recall': { const list = memory.recall({ query: a.query, kind: a.kind, tag: a.tags?.[0], limit: a.limit }); return list.length ? list.map(formatNote).join('\n\n') : 'No matching notes.'; }
          case 'confirm': { if (!a.id) return 'id is required'; const n = memory.confirm(a.id); return n ? `re-verified ${n.id}: ${n.status}` : `no note ${a.id}`; }
          case 'forget': return a.id ? (memory.forget(a.id) ? `forgot ${a.id}` : `no note ${a.id}`) : 'id is required';
          case 'list': { const list = memory.list(); return list.length ? list.map((n) => `${n.id}  [${n.kind}] ${n.status}  ${n.title}`).join('\n') : 'No notes yet.'; }
          default: return 'unknown action';
        }
      },
    },
    {
      name: 'handoff',
      description: 'Session continuity. action "save" at the end of a session (summary, next_steps, files you touched); "read" at the start (flags files that changed and commits that landed since).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'read'] },
          summary: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      },
      async run(a) {
        if (a.action === 'save') { const h = memory.saveHandoff(a); return `handoff saved (${h.nextSteps.length} next step(s), ${h.files.length} file(s) tracked)`; }
        return formatHandoff(memory.readHandoff());
      },
    },
    {
      name: 'realtime',
      description: 'Switch realtime updates on or off, or check them. On: after each file edit a hook refreshes the map in the background (one rebuild per burst of edits) and adds a short warning when the edited file has public records, many importers, or code that just lost its last reference. Turn it off for bulk or generated changes; it costs nothing while off.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status'], default: 'status' } } },
      async run(a) {
        const action = a.action ?? 'status';
        if (action === 'on' || action === 'off') setEnabled(out, action === 'on');
        const s = realtimeStatus(out);
        return `realtime ${s.enabled ? 'ON' : 'OFF'}${s.rebuilding ? ' (rebuilding now)' : ''}${s.enabled && !hookInstalled(root) ? '. The edit hook is not installed in this project, so nothing triggers it yet: run `map-it-all init --hook`.' : ''}`;
      },
    },
    {
      name: 'refresh',
      description: 'Force a rebuild of the map now. with_knip also runs Knip if the project has it installed (slow) and adds unused file/export candidates.',
      inputSchema: { type: 'object', properties: { with_knip: { type: 'boolean', default: false } } },
      async run(a) {
        const { stamp } = await buildMap({ root, out, withKnip: Boolean(a.with_knip) });
        cache = null;
        return `rebuilt in ${stamp.ms} ms: ${Object.entries(stamp.counts).map(([k, v]) => `${k} ${v}`).join(', ')}${stamp.errors.length ? `\nproblems: ${stamp.errors.map((e) => `${e.extractor}: ${e.message}`).join('; ')}` : ''}`;
      },
    },
    {
      name: 'view',
      description: 'Path of the interactive zoomable treemap (graph.html) for the user. open:true launches it in their browser.',
      inputSchema: { type: 'object', properties: { open: { type: 'boolean', default: false } } },
      async run(a) {
        await ensureFresh();
        const file = path.join(out, 'graph.html');
        if (!existsSync(file)) return 'graph.html missing; call refresh.';
        if (a.open) {
          const [bin, argv] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [file]];
          spawn(bin, argv, { detached: true, stdio: 'ignore' }).unref();
        }
        return `${file}${a.open ? ' (opened)' : ''}`;
      },
    },
  ];

  const enabled = new Set(PROFILES[profile] ?? PROFILES.standard);
  const active = tools.filter((t) => enabled.has(t.name));

  async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && { id, result };
    const fail = (code, message) => id !== undefined && { id, error: { code, message } };
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'map-it-all', version: VERSION },
            instructions: INSTRUCTIONS,
          });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: active.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = active.find((t) => t.name === params?.name);
          if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
          try {
            return reply({ content: [{ type: 'text', text: clip(String(await tool.run(params.arguments ?? {}))) }] });
          } catch (error) {
            return reply({ content: [{ type: 'text', text: `${tool.name} failed: ${error.message ?? error}` }], isError: true });
          }
        }
        case 'resources/list': return reply({ resources: [] });
        case 'prompts/list': return reply({ prompts: [] });
        default:
          if (method?.startsWith('notifications/')) return undefined;
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return fail(-32603, String(error.message ?? error));
    }
  }

  return { handle, tools: active, allTools: tools, root, out };
}

/** Run the server on stdio. */
export function serveStdio(options) {
  const server = createServer(options);
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      server.handle(msg).then((r) => r && send(r));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`map-it-all MCP ready: root ${server.root}, map ${server.out}, tools ${server.tools.map((t) => t.name).join(',')}\n`);
}
