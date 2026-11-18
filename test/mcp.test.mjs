// Drives the real server process the way an MCP client does.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, write } from './fixtures.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'map-it-all.mjs');

function client(root, profile, online = false) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', root, ...(profile ? ['--profile', profile] : []), ...(online ? ['--online'] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
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
  return { call, tool, raw, child, close: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('close', resolve); child.stdin.end(); }) };
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
    assert.deepEqual(list, ['brief', 'find', 'file', 'connections', 'leads', 'symbol', 'diff', 'deps', 'memory', 'handoff', 'realtime'], 'standard profile');
    assert.match((await c.tool('realtime')).text, /realtime OFF/, 'off until you turn it on');
    assert.match((await c.tool('realtime', { action: 'on' })).text, /realtime ON.*edit hook is not installed/s, 'it tells you when nothing can trigger it');
    assert.match((await c.tool('realtime', { action: 'off' })).text, /realtime OFF/);

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
  } finally { await c.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('MCP profiles control the tool surface', async () => {
  const root = fixture();
  const c = client(root, 'minimal');
  try {
    await c.call('initialize', {});
    const tools = (await c.call('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['brief', 'find', 'connections', 'memory']);
    assert.ok(JSON.stringify(tools).length / 4 < 1000, 'minimal profile stays under about 1000 tokens');
  } finally { await c.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('MCP deps respects offline policy, refresh, explicit online, and the offline override', async () => {
  const root = fixture();
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { lodash: '^4.17.15' };
  write(root, 'package.json', JSON.stringify(pkg));
  write(root, 'package-lock.json', JSON.stringify({ name: 'fx', lockfileVersion: 3, packages: {
    '': { name: 'fx', dependencies: { lodash: '^4.17.15' } },
    'node_modules/lodash': { version: '4.17.15' },
  } }));
  write(root, 'web/dep.ts', "import lodash from 'lodash';\nexport default lodash;\n");

  const hits = { batch: 0, vuln: 0, npm: 0 };
  let failBatch = false;
  const vuln = JSON.parse(readFileSync(new URL('./fixtures/osv-lodash-ghsa-35jh-r3h4-6jhm.json', import.meta.url), 'utf8'));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/querybatch') {
        hits.batch++;
        if (failBatch) { res.statusCode = 500; res.end('{}'); return; }
        const queries = JSON.parse(body).queries;
        res.end(JSON.stringify({ results: queries.map((q) => q.package.name === 'lodash' ? { vulns: [{ id: vuln.id }] } : {}) }));
      } else if (req.url === `/v1/vulns/${vuln.id}`) {
        hits.vuln++;
        res.end(JSON.stringify(vuln));
      } else {
        hits.npm++;
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prior = { osv: process.env.MAP_IT_ALL_OSV_URL, npm: process.env.MAP_IT_ALL_NPM_URL, offline: process.env.MAP_IT_ALL_OFFLINE };
  process.env.MAP_IT_ALL_OSV_URL = base;
  process.env.MAP_IT_ALL_NPM_URL = base;
  try {
    const c = client(root);
    try {
      const offline = await c.tool('deps');
      assert.match(offline.text, /Network lookups are off/);
      assert.deepEqual(hits, { batch: 0, vuln: 0, npm: 0 });
      const refresh = await c.tool('deps', { refresh: true });
      assert.match(refresh.text, /Network lookups are off/);
      assert.deepEqual(hits, { batch: 0, vuln: 0, npm: 0 }, 'refresh cannot enable requests');
    } finally { await c.close(); }

    const online = client(root, undefined, true);
    try {
      const result = await online.tool('deps');
      assert.match(result.text, /HIGH\s+lodash@4\.17\.15/);
      assert.match(result.text, /exposed in 1 file\(s\): web\/dep\.ts/);
      assert.deepEqual(hits, { batch: 1, vuln: 1, npm: 1 });
    } finally { await online.close(); }

    const cacheFile = path.join(root, '.map-it-all', 'deps-cache.json');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    cache.osv['lodash@4.17.15'].at -= 25 * 36e5;
    writeFileSync(cacheFile, JSON.stringify(cache));
    failBatch = true;
    const failedRefresh = client(root, undefined, true);
    try {
      const result = await failedRefresh.tool('deps');
      assert.doesNotMatch(result.text, /No known vulnerabilities/);
      assert.match(result.text, /partial: .*package lookup\(s\) failed to refresh/);
      assert.match(result.text, /OSV lookup failed/);
    } finally { await failedRefresh.close(); }

    const offlineAfterFailure = client(root);
    try {
      assert.match((await offlineAfterFailure.tool('brief')).text, /partially checked/);
      const result = await offlineAfterFailure.tool('deps');
      assert.match(result.text, /partial: .*package lookup\(s\) failed to refresh/);
      assert.doesNotMatch(result.text, /No known vulnerabilities/);
      assert.deepEqual(hits, { batch: 2, vuln: 1, npm: 1 }, 'the separate offline MCP process makes no requests');
    } finally { await offlineAfterFailure.close(); }

    failBatch = false;
    const recovered = client(root, undefined, true);
    try {
      const result = await recovered.tool('deps');
      assert.match(result.text, /HIGH\s+lodash@4\.17\.15/);
      assert.doesNotMatch(result.text, /partial: .*package lookup\(s\) failed to refresh/);
      assert.match((await recovered.tool('brief')).text, /checked/);
      assert.equal(hits.batch, 3, 'the successful online invocation retries the stale item');
    } finally { await recovered.close(); }

    process.env.MAP_IT_ALL_OFFLINE = '1';
    rmSync(path.join(root, '.map-it-all', 'deps-cache.json'), { force: true });
    const forcedOffline = client(root, undefined, true);
    try {
      const result = await forcedOffline.tool('deps', { refresh: true });
      assert.match(result.text, /MAP_IT_ALL_OFFLINE=1 is set/);
      assert.deepEqual(hits, { batch: 3, vuln: 1, npm: 1 }, 'offline override wins even with --online and refresh');
    } finally { await forcedOffline.close(); }
  } finally {
    for (const [key, value] of [['MAP_IT_ALL_OSV_URL', prior.osv], ['MAP_IT_ALL_NPM_URL', prior.npm], ['MAP_IT_ALL_OFFLINE', prior.offline]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});

test('tools/call validates arguments against each inputSchema before the tool runs', async () => {
  const root = fixture();
  const c = client(root);
  try {
    await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const rejected = [
      ['connections', {}, /connections: target is required/],
      ['connections', { target: 'convex/lib.ts', depth: 99 }, /depth must be at most 4 \(got 99\)/],
      ['find', { limit: 'ten' }, /limit must be an integer \(got string\)/],
      ['memory', { action: 'drop' }, /action must be one of remember, recall, confirm, forget, list/],
      ['memory', { action: 'remember', title: 'x', body: 'y', anchors: 'server/app.ts' }, /anchors must be an array \(got string\)/],
      ['memory', { action: 'remember', title: 'x', body: 'y', anchors: [1] }, /anchors\[0\] must be a string/],
      ['brief', ['not', 'an', 'object']],
    ];
    for (const [name, args, message] of rejected) {
      const r = await c.call('tools/call', { name, arguments: args });
      assert.equal(r.error?.code, -32602, `${name} ${JSON.stringify(args)} is a protocol error`);
      assert.match(r.error.message, /^invalid arguments for /, 'the message names the tool');
      assert.match(r.error.message, message ?? /arguments must be an object/);
      assert.equal(r.result, undefined, 'no tool result is returned');
    }
    // The memory calls above were refused before the tool ran: nothing was saved.
    assert.equal((await c.tool('memory', { action: 'list' })).text, 'No notes yet.');

    // Unknown properties are ignored (compatibility), and valid arguments still work.
    assert.match((await c.tool('find', { flag: 'unmounted', surprise: true })).text, /express:GET \/lost/);
    assert.match((await c.tool('brief', { extra: 1 })).text, /Session brief/);
    for (const line of c.raw) JSON.parse(line); // stdout carried only protocol messages
  } finally { await c.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});

test('initialize answers with a supported protocol version, not whatever string the client sent', async () => {
  const root = fixture();
  const c = client(root);
  try {
    assert.equal((await c.call('initialize', { protocolVersion: '2025-03-26' })).result.protocolVersion, '2025-03-26', 'a supported version is echoed');
    assert.equal((await c.call('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'an unknown version gets the newest supported one');
    assert.equal((await c.call('initialize', { protocolVersion: 2025 })).result.protocolVersion, '2025-06-18', 'a non-string version gets the newest supported one');
    assert.equal((await c.call('initialize', {})).result.protocolVersion, '2025-06-18', 'no version gets the newest supported one');
  } finally { await c.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});
