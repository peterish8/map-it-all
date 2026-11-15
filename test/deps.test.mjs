// Dependencies: the offline extractor, lockfile readers, advisories against a local fake OSV and
// registry, the network gate, version-pinned memory, and the docs excerpt logic.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cvss3, fixedIn, slimVuln } from '../src/advisories.mjs';
import { buildMap } from '../src/build.mjs';
import { loadConfig } from '../src/config.mjs';
import { depsSummary, runDeps, versionOfFrom } from '../src/deps.mjs';
import { excerptLlms, excerptMarkdown } from '../src/docs.mjs';
import { packageName } from '../src/imports.mjs';
import { loadLocks } from '../src/lock.mjs';
import { createMemory } from '../src/memory.mjs';
import { assertPublicUrl, clean, networkPolicy } from '../src/net.mjs';
import { loadStore } from '../src/store.mjs';
import { write } from './fixtures.mjs';

const rm = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });

const LOCK = {
  name: 'app', lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { lodash: '^4.17.0', 'left-pad': '^1.0.0' }, devDependencies: { eslint: '^8.0.0' } },
    'node_modules/lodash': { version: '4.17.15', dependencies: { inner: '^1.0.0' } },
    'node_modules/inner': { version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/eslint': { version: '8.0.0', bin: { eslint: 'bin/eslint.js' } },
  },
};

function project(lock = LOCK) {
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-deps-'));
  write(root, 'package.json', JSON.stringify({ name: 'app', scripts: { lint: 'eslint .' }, dependencies: { lodash: '^4.17.0', 'left-pad': '^1.0.0', '@types/node': '^20.0.0' }, devDependencies: { eslint: '^8.0.0' } }));
  write(root, 'package-lock.json', JSON.stringify(lock));
  write(root, 'src/a.ts', "import debounce from 'lodash/debounce';\nimport fs from 'node:fs';\nimport { x } from './b';\nexport const a = [debounce, fs, x];\n");
  write(root, 'src/b.ts', "import { get } from 'lodash';\nexport const x = get;\n");
  return { root, out: path.join(root, '.map-it-all') };
}

test('packageName finds the package in any import specifier, and ignores relative, builtin and node: ones', () => {
  assert.equal(packageName('lodash/debounce'), 'lodash');
  assert.equal(packageName('@scope/pkg/deep/path'), '@scope/pkg');
  assert.equal(packageName('@scope'), null);
  for (const s of ['./x', '../y', '/abs', 'node:fs', 'fs', 'fs/promises', 'path', 'https://x.dev/m.js']) assert.equal(packageName(s), null, s);
});

test('the extractor joins each declared dependency to the files that import it, offline', async () => {
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const lodash = store.byId.get('dep:lodash');
    assert.equal(lodash.version, '4.17.15');
    assert.equal(lodash.refCount, 2, 'lodash/debounce and lodash both count');
    assert.deepEqual(lodash.refs.map((r) => r.path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(lodash.line, 1, 'points at the line in package.json');
    assert.ok(store.byId.get('dep:left-pad').flags.includes('no-refs'), 'a production dependency nothing imports is a lead');
    assert.deepEqual(store.byId.get('dep:eslint').flags, [], 'dev tools used by scripts are not leads');
    assert.deepEqual(store.byId.get('dep:@types/node').flags, [], 'type packages are never leads');
    assert.ok(!store.byId.has('dep:fs'), 'builtins are not dependencies');
    assert.equal(store.stamp.stats.depsDirect, 4);
    assert.match(store.stamp.stats.depsLockSig, /^[0-9a-f]{12}$/);
  } finally { rm(root); }
});

test('yarn.lock and pnpm-lock.yaml are read into the same model', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-lock-'));
  try {
    write(root, 'yarn.lock', ['# yarn lockfile v1', '', '"@scope/a@^1.0.0", "@scope/a@^1.2.0":', '  version "1.2.3"', '  dependencies:', '    b "^2.0.0"', '', 'b@^2.0.0:', '  version "2.1.0"', ''].join('\n'));
    const yarn = loadLocks(root, ['']).for('');
    const id = yarn.lock.direct('', '@scope/a', '^1.2.0');
    assert.deepEqual(yarn.lock.info(id), { name: '@scope/a', version: '1.2.3', bin: [] });
    assert.deepEqual(yarn.lock.depsOf(id).map((d) => yarn.lock.info(d).version), ['2.1.0']);

    write(root, 'sub/pnpm-lock.yaml', ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:', '      react:', '        specifier: ^18.0.0', '        version: 18.2.0(typescript@5.0.0)', 'packages:', "  react@18.2.0:", '    resolution: {integrity: x}', ''].join('\n'));
    const pnpm = loadLocks(root, ['sub']).for('sub');
    assert.equal(pnpm.lock.info(pnpm.lock.direct('', 'react')).version, '18.2.0');
  } finally { rm(root); }
});

test('CVSS 3 scores match the specification, and OSV records are reduced and cleaned', () => {
  assert.equal(cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
  assert.equal(cvss3('CVSS:4.0/AV:N'), null);
  const v = slimVuln({ id: 'GHSA-x', summary: 'bad\u0007\n thing', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [{ package: { ecosystem: 'npm', name: 'p' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.0' }, { fixed: '2.0.1' }] }] }] });
  assert.equal(v.severity, 'CRITICAL');
  assert.equal(v.summary, 'bad thing');
  assert.equal(fixedIn(v, 'p', '1.5.0'), '2.0.1', 'the smallest fixed version above the installed one');
  assert.equal(clean('a\u0000b\n\n c', 10), 'a b c');
});

test('the network is off unless the user turns it on, and a hostile docs URL cannot reach local hosts', async () => {
  assert.equal(networkPolicy({ config: {}, env: {} }).allowed, false);
  assert.equal(networkPolicy({ config: { network: true }, env: {} }).allowed, true);
  assert.equal(networkPolicy({ config: {}, allow: true, env: {} }).allowed, true);
  assert.equal(networkPolicy({ config: { network: true }, allow: true, env: { MAP_IT_ALL_OFFLINE: '1' } }).allowed, false, 'the offline switch beats everything');
  for (const bad of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://[::ffff:7f00:1]/x', 'ftp://example.com']) {
    await assert.rejects(assertPublicUrl(bad), undefined, bad);
  }
});

test('advisories: nothing is fetched offline; online finds direct and transitive findings, their files, and caches them', async () => {
  const hits = { osv: 0, npm: 0, vuln: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/querybatch') {
        hits.osv++;
        res.end(JSON.stringify({ results: JSON.parse(body).queries.map((q) => (q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-aaaa' }] } : q.package.name === 'inner' ? { vulns: [{ id: 'GHSA-bbbb' }] } : {})) }));
      } else if (req.url.startsWith('/v1/vulns/')) {
        hits.vuln++;
        const id = decodeURIComponent(req.url.slice(10));
        res.end(JSON.stringify(id === 'GHSA-aaaa'
          ? { id, summary: 'Prototype Pollution in lodash', database_specific: { severity: 'HIGH' }, affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] }
          : { id, summary: 'Remote code execution', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }));
      } else {
        hits.npm++;
        res.end(JSON.stringify(req.url === '/lodash/4.17.15' ? { deprecated: 'use native methods', homepage: 'https://lodash.com', repository: { url: 'git+https://github.com/lodash/lodash.git' } } : {}));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.MAP_IT_ALL_OSV_URL = base;
  process.env.MAP_IT_ALL_NPM_URL = base;
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });

    const offline = await runDeps({ root, out, store, memory, config, args: {} });
    assert.match(offline, /Dependencies: 4 direct \(3 prod, 1 dev\)/);
    assert.match(offline, /Advisories: not checked yet/, 'never "0 vulnerable" when nothing was checked');
    assert.match(offline, /Network lookups are off/);
    assert.match(offline, /Possibly unused production dependencies.*left-pad/);
    assert.deepEqual(hits, { osv: 0, npm: 0, vuln: 0 }, 'offline means no request at all');
    assert.match(depsSummary(out, store), /^Dependencies: 4 direct \(1 dev\), 1 possibly unused; advisories not checked/);

    // An agent asking for a refresh does not turn the network on.
    const asked = await runDeps({ root, out, store, memory, config, args: { refresh: true } });
    assert.match(asked, /Network lookups are off/);
    assert.equal(hits.osv, 0);

    const online = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.equal(hits.osv, 1, 'one batched request for the whole lockfile');
    assert.match(online, /Advisories: 2 vulnerable package version\(s\), 1 deprecated/);
    assert.match(online, /inner@1\.0\.0\s+\[via lodash\]\s+GHSA-bbbb.*Remote code execution/s, 'a transitive finding names the direct dependency that pulls it in');
    assert.match(online, /CRITICAL/);
    assert.match(online, /lodash@4\.17\.15\s+\[direct\][\s\S]*GHSA-aaaa.*Fixed in 4\.17\.21/);
    assert.match(online, /exposed in 2 file\(s\): src\/[ab]\.ts:\d/, 'the files in YOUR repo that reach it');
    assert.match(online, /Deprecated:\s+lodash@4\.17\.15: use native methods/);
    assert.match(online, /Advisory data: OSV\.dev/, 'the data source is credited');
    assert.ok(online.indexOf('CRITICAL') < online.indexOf('HIGH'), 'worst first');

    const before = { ...hits };
    const again = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.deepEqual(hits, before, 'a second run is served from the cache');
    assert.match(again, /checked/);
    assert.match(depsSummary(out, store), /2 vulnerable \(2 high or critical\), 1 deprecated, checked/);

    const detail = await runDeps({ root, out, store, memory, config, args: { package: 'lodash' } });
    assert.match(detail, /imported by 2 file\(s\)/);
    assert.match(detail, /GHSA-aaaa/);
    assert.match(detail, /DEPRECATED 4\.17\.15/);

    const docs = await runDeps({ root, out, store, memory, config, args: { package: 'lodash', docs: 'debounce' } });
    assert.match(docs, /No saved docs for lodash@4\.17\.15\. Network lookups are off/);
  } finally {
    delete process.env.MAP_IT_ALL_OSV_URL;
    delete process.env.MAP_IT_ALL_NPM_URL;
    await new Promise((r) => server.close(r));
    rm(root);
  }
});

test('a docs note pinned to a version flags itself when the dependency version changes or goes away', () => {
  const { root, out } = project();
  try {
    let versions = ['4.17.15'];
    const memory = createMemory({ root, dir: path.join(out, 'memory'), versionOf: (pkg) => (pkg === 'lodash' ? versions : undefined) });
    memory.remember({ title: 'docs: lodash@4.17.15', body: 'source: x\nuse _.debounce', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.15' }] });
    assert.equal(memory.list()[0].status, 'fresh');
    versions = ['4.17.21'];
    const stale = memory.list()[0];
    assert.equal(stale.status, 'stale');
    assert.match(stale.anchorStates[0].detail, /lodash is now 4\.17\.21; this note was written for 4\.17\.15/);
    assert.equal(memory.confirm(stale.id).status, 'fresh', 'confirm re-pins to what is installed');
    versions = [];
    assert.equal(memory.list()[0].status, 'orphaned', 'a removed dependency orphans its docs');
    versions = undefined;
    assert.equal(createMemory({ root, dir: path.join(out, 'memory'), versionOf: () => undefined }).list()[0].status, 'fresh', 'unknown is not stale');
    assert.equal(versionOfFrom(() => null)('lodash'), undefined, 'no map yet: cannot tell');
  } finally { rm(root); }
});

test('docs excerpts pick the sections that answer the question and stay inside the budget', () => {
  const readme = ['# pkg', 'Tiny library.', '![badge](x.png)', '## Install', 'npm i pkg', '## Debounce', 'Use `pkg.debounce(fn, 200)` to wait.', '## License', 'MIT'].join('\n');
  const hit = excerptMarkdown(readme, 'how to debounce');
  assert.match(hit, /## Debounce[\s\S]*pkg\.debounce/);
  assert.doesNotMatch(hit, /badge/);
  assert.ok(excerptMarkdown(`# big\n${'word '.repeat(5000)}`, '', 500).length <= 520);
  const llms = ['# Pkg', '> Short summary', '', '- [Install](https://x.dev/install.md): setup', '- [Debounce](https://x.dev/debounce.md): wait before calling'].join('\n');
  const idx = excerptLlms(llms, 'debounce', 120);
  assert.match(idx, /Debounce/);
  assert.match(idx, /Short summary/);
});
