// Drives the real server process the way an MCP client does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs');

function client(root, profile) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', root, ...(profile ? ['--profile', profile] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let n = 0;
  const waiting = new Map();
  const raw = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      raw.push(line);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  const call = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => { const r = await call('tools/call', { name, arguments: args }); return { text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError, error: r.error }; };
  return { call, tool, raw, child, close: () => { child.stdin.end(); } };
}

test('MCP server: handshake, profiles, tools, memory round trip, errors', async () => {
  const root = fixture();
  const c = client(root);
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'map-it-all');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    c.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.deepEqual(list, ['brief', 'find', 'file', 'connections', 'leads', 'symbol', 'diff', 'memory', 'handoff'], 'standard profile');

    const brief = (await c.tool('brief')).text;
    assert.match(brief, /Session brief/);
    assert.match(brief, /convex: 5 functions/);
    assert.match(brief, /express: 9 routes/);
    assert.ok(brief.length < 6000);

    const conn = (await c.tool('connections', { target: 'packages/shared/a.ts', direction: 'in' })).text;
    assert.match(conn, /web\/call\.ts/);
    const mer = (await c.tool('connections', { target: 'convex/lib.ts', format: 'mermaid' })).text;
    assert.match(mer, /^graph LR/);

    const rec = (await c.tool('connections', { target: 'convex:lib.dead' })).text;
    assert.match(rec, /No by-name callers recorded for convex:lib\.dead.*public/s, 'record-scoped answer warns about public surface');

    assert.match((await c.tool('find', { flag: 'unmounted' })).text, /express:GET \/lost/);
    assert.match((await c.tool('leads', { kind: 'doc-drift' })).text, /CLAUDE\.md/);
    assert.match((await c.tool('symbol', { name: 'fooRouter' })).text, /declared server\/routes\/foo\.ts/);
    assert.match((await c.tool('file', { path: 'index.ts' })).text, /ambiguous|packages\/shared\/src\/index\.ts/);

    const saved = await c.tool('memory', { action: 'remember', title: 'Mount order', body: 'Health route stays above routers.', kind: 'decision', anchors: ['server/app.ts'] });
    assert.match(saved.text, /anchored to 1 file/);
    assert.match((await c.tool('memory', { action: 'recall', query: 'mount order' })).text, /FRESH/);
    assert.match((await c.tool('brief')).text, /Memory: 1 note/);
    assert.match((await c.tool('handoff', { action: 'save', summary: 'half done', next_steps: ['finish'] })).text, /saved/);
    assert.match((await c.tool('handoff', { action: 'read' })).text, /half done/);

    const bad = await c.tool('memory', { action: 'remember', title: 'x', body: 'y', anchors: ['missing.ts'] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not a file/);
    assert.equal((await c.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await c.call('bogus/method', {})).error.code, -32601);

    for (const line of c.raw) JSON.parse(line); // stdout carried only protocol messages
  } finally { c.close(); rmSync(root, { recursive: true, force: true }); }
});

test('MCP profiles control the tool surface', async () => {
  const root = fixture();
  const c = client(root, 'minimal');
  try {
    await c.call('initialize', {});
    const tools = (await c.call('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['brief', 'find', 'connections', 'memory']);
    assert.ok(JSON.stringify(tools).length / 4 < 1000, 'minimal profile stays under about 1000 tokens');
  } finally { c.close(); rmSync(root, { recursive: true, force: true }); }
});
