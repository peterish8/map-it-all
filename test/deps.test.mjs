// Dependencies: the offline extractor, lockfile readers, advisories against a local fake OSV and
// registry, the network gate, version-pinned memory, and the docs excerpt logic.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { advisoriesFor, cvss3, fixedIn, loadCache, registryFor, saveCache, slimVuln } from '../src/advisories.mjs';
import { buildMap, isFresh } from '../src/build.mjs';
import { loadConfig } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { depsSummary, runDeps, versionOfFrom } from '../src/deps.mjs';
import { docsFor, excerptLlms, excerptMarkdown } from '../src/docs.mjs';
import { packageName } from '../src/imports.mjs';
import { loadLocks } from '../src/lock.mjs';
import { createMemory } from '../src/memory.mjs';
import { assertPublicUrl, clean, fetchText, networkPolicy } from '../src/net.mjs';
import { loadStore } from '../src/store.mjs';
import { write } from './fixtures.mjs';

const rm = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });

const LOCK = {
  name: 'app', lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { lodash: '^4.17.0', 'left-pad': '^1.0.0', '@types/node': '^20.0.0' }, devDependencies: { eslint: '^8.0.0' } },
    'node_modules/lodash': { version: '4.17.15', dependencies: { inner: '^1.0.0' } },
    'node_modules/inner': { version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/eslint': { version: '8.0.0', bin: { eslint: 'bin/eslint.js' } },
    'node_modules/@types/node': { version: '20.0.0' },
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

test('deps reports unknown coverage without a lockfile and does not claim a complete brief', async () => {
  const { root, out } = project();
  try {
    rmSync(path.join(root, 'package-lock.json'));
    write(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0' } }));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.match(result, /Advisories: not checked yet; 0 of 1 direct dependencies resolved; 1 unresolved/);
    assert.doesNotMatch(result, /No known vulnerabilities/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
    assert.doesNotMatch(depsSummary(out, store), /checked \d/);
  } finally { rm(root); }
});

test('deps reports partial direct coverage when one of two dependencies has no reachable exact version', async () => {
  const { root, out } = project();
  try {
    write(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0', 'unlocked-package': '^1.0.0' } }));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.match(result, /1 of 2 direct dependencies resolved; 1 unresolved/);
    assert.doesNotMatch(result, /No known vulnerabilities/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
    assert.doesNotMatch(depsSummary(out, store), /checked \d/);
  } finally { rm(root); }
});

test('every duplicate workspace declaration must resolve before direct coverage is complete', async () => {
  const fake = await fakeOsv({ ids: [] });
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-workspaces-'));
  const out = path.join(root, '.map-it-all');
  const lock = { name: 'root', lockfileVersion: 3, packages: {
    '': { name: 'root' },
    'packages/a/node_modules/shared': { version: '1.0.0' },
  } };
  try {
    write(root, 'package.json', JSON.stringify({ name: 'root' }));
    write(root, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { shared: '^1.0.0' } }));
    write(root, 'packages/b/package.json', JSON.stringify({ name: 'b', dependencies: { shared: '^1.0.0' } }));
    write(root, 'package-lock.json', JSON.stringify(lock));
    await buildMap({ root, out });
    let store = loadStore(out);
    assert.equal(store.byId.get('dep:shared').declarations.length, 2);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    let result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /1 of 2 direct dependencies resolved; 1 unresolved/);
    assert.doesNotMatch(result, /No known vulnerabilities/);
    assert.equal(loadCache(out).summary.complete, false);

    lock.packages['packages/b/node_modules/shared'] = { version: '1.0.0' };
    write(root, 'package-lock.json', JSON.stringify(lock));
    await buildMap({ root, out });
    store = loadStore(out);
    result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /No known vulnerabilities for the installed versions/);
    assert.equal(loadCache(out).summary.complete, true);
  } finally { await fake.close(); rm(root); }
});

test('uncapped workspace declarations are traversed, including a unique dependency after the display cap', async () => {
  const fake = await fakeOsv({ ids: [] });
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-many-workspaces-'));
  const out = path.join(root, '.map-it-all');
  const packages = { '': { name: 'root' } };
  write(root, 'package.json', JSON.stringify({ name: 'root' }));
  for (let i = 0; i < 13; i++) {
    const dir = `packages/w${i}`;
    const dependencies = { shared: '^1.0.0' };
    packages[`${dir}/node_modules/shared`] = { version: '1.0.0' };
    if (i === 12) {
      dependencies['last-only'] = '^2.0.0';
      packages[`${dir}/node_modules/last-only`] = { version: '2.3.0' };
    }
    write(root, `${dir}/package.json`, JSON.stringify({ name: `w${i}`, dependencies }));
  }
  write(root, 'package-lock.json', JSON.stringify({ name: 'root', lockfileVersion: 3, packages }));
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    assert.equal(store.byId.get('dep:shared').declaredIn.length, 12, 'display metadata stays capped');
    assert.equal(store.byId.get('dep:shared').declarations.length, 13, 'all eligible declarations persist');
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /2 installed copies/);
    assert.doesNotMatch(result, /unresolved/);
    assert.equal(loadCache(out).summary.complete, true);
  } finally { await fake.close(); rm(root); }
});

test('pnpm direct entries stay partial, suppress clean claims, and mixed workspaces remain conservative', async () => {
  const fake = await fakeOsv({ ids: [] });
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-mixed-locks-'));
  const out = path.join(root, '.map-it-all');
  try {
    write(root, 'package.json', JSON.stringify({ name: 'root', dependencies: { alpha: '^1.0.0' } }));
    write(root, 'package-lock.json', JSON.stringify({ name: 'root', lockfileVersion: 3, packages: {
      '': { name: 'root', dependencies: { alpha: '^1.0.0' } },
      'node_modules/alpha': { version: '1.1.0' },
    } }));
    write(root, 'packages/p/package.json', JSON.stringify({ name: 'pnpm-child', dependencies: { beta: '^2.0.0' } }));
    write(root, 'packages/p/pnpm-lock.yaml', ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:', '      beta:', '        specifier: ^2.0.0', '        version: 2.1.0', 'packages:', '  beta@2.1.0:', '    resolution: {integrity: x}', '  transitive@4.0.0:', '    resolution: {integrity: y}', ''].join('\n'));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /Transitive dependencies were not checked/);
    assert.doesNotMatch(result, /No known vulnerabilities/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
  } finally { await fake.close(); rm(root); }
});

test('package detail does not claim an advisory result without an exact lockfile version', async () => {
  const { root, out } = project();
  try {
    rmSync(path.join(root, 'package-lock.json'));
    write(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0' } }));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const detail = await runDeps({ root, out, store, memory, config, args: { package: 'lodash' }, allowOnline: false });
    assert.match(detail, /advisories: not checked; this direct dependency has no exact installed version/);
    assert.doesNotMatch(detail, /no known advisories/);
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

test('npm v2 resolution walks workspace and intermediate node_modules, including transitive and scoped packages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-npm-resolution-'));
  try {
    const packages = {
      '': {},
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } },
      'node_modules/c': { version: '1.0.0' },
      'node_modules/@scope/pkg': { version: '1.0.0' },
      'packages/node_modules/a': { version: '2.0.0', dependencies: { b: '2' } },
      'packages/node_modules/b': { version: '2.0.0' },
      'packages/node_modules/c': { version: '2.0.0' },
      'packages/node_modules/@scope/pkg': { version: '2.0.0' },
      'packages/app/node_modules/a': { version: '3.0.0', dependencies: { b: '3' } },
      'packages/app/node_modules/a/node_modules/b': { version: '3.0.0' },
    };
    write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
    const lock = loadLocks(root, ['packages/app']).for('packages/app').lock;
    const direct = (name) => lock.direct('packages/app', name);
    assert.equal(lock.info(direct('a')).version, '3.0.0', 'workspace local version wins');
    assert.equal(lock.info(lock.depsOf(direct('a'))[0]).version, '3.0.0', 'nested transitive version wins');
    assert.equal(lock.info(direct('c')).version, '2.0.0', 'intermediate version wins over root');
    assert.equal(lock.info(direct('@scope/pkg')).version, '2.0.0', 'scoped name stays one package path');
    assert.equal(direct('missing'), null);

    write(root, 'packages/app/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '9.0.0' } } }));
    const nearer = loadLocks(root, ['packages/app']).for('packages/app');
    assert.equal(nearer.lock.info(nearer.lock.direct('', 'a')).version, '9.0.0', 'nearer lock governs the workspace');
  } finally { rm(root); }
});

test('nested npm workspace lock resolution reaches vulnerabilities and attributes them to the workspace direct dependency', async () => {
  const fake = await fakeOsv({ ids: [] });
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-npm-attribution-'));
  const out = path.join(root, '.map-it-all');
  try {
    fake.state.batchResponse = (queries) => ({ results: queries.map((q) => q.package.name === 'inner' ? { vulns: [{ id: 'GHSA-inner' }] } : {}) });
    write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    write(root, 'packages/app/package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.0.0' } }));
    write(root, 'packages/app/src/use.js', "import _ from 'lodash'; export default _;\n");
    write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'root' },
      'packages/app/node_modules/lodash': { version: '4.5.0', dependencies: { inner: '^2.0.0' } },
      'packages/node_modules/inner': { version: '2.1.0' },
      'node_modules/inner': { version: '1.0.0' },
    } }));
    await buildMap({ root, out });
    const store = loadStore(out);
    assert.equal(store.byId.get('dep:lodash').version, '4.5.0', 'extractor resolves direct workspace package');
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /inner@2\.1\.0\s+\[via lodash\]/, 'transitive intermediate version is reached and attributed');
    assert.match(result, /inner@2\.1\.0[\s\S]*?exposed in 1 file\(s\)/);
  } finally { await fake.close(); rm(root); }
});

test('offline expired advisory lookups and details stay partial at exact TTL boundaries without requests', async () => {
  const { root, out } = project();
  try {
    const now = 10_000_000;
    const cache = loadCache(out);
    cache.osv['p@1.0.0'] = { ids: [], at: now - 24 * 36e5 };
    cache.osv['q@1.0.0'] = { ids: ['GHSA-shared'], at: now };
    cache.osv['r@1.0.0'] = { ids: ['GHSA-shared'], at: now };
    cache.osv['s@1.0.0'] = { ids: ['GHSA-vuln'] };
    cache.vulns['GHSA-shared'] = { id: 'GHSA-shared', aliases: [], summary: 'cached', severity: 'HIGH', score: null, malware: false, withdrawn: true, fixed: {}, at: now - 7 * 24 * 36e5 };
    cache.vulns['GHSA-vuln'] = { id: 'GHSA-vuln', aliases: [], summary: 'still visible', severity: 'HIGH', score: null, malware: false, withdrawn: false, fixed: {} };
    saveCache(out, cache);
    const result = await advisoriesFor({ out, targets: ['p', 'q', 'r', 's'].map((name) => ({ name, version: '1.0.0' })), online: false, now });
    assert.equal(result.expiredLookupsNotAttempted, 2, 'age boundary and missing lookup timestamp both expire');
    assert.equal(result.expiredDetailsNotAttempted, 2, 'shared advisory ID counts once, and missing detail timestamp expires');
    assert.ok(result.stale > 0);
    assert.deepEqual(result.byKey.get('q@1.0.0'), [], 'withdrawn detail remains excluded from findings');
    assert.equal(result.byKey.get('s@1.0.0')[0].id, 'GHSA-vuln', 'cached vulnerable finding survives expiry');
    assert.equal(loadCache(out).osv['p@1.0.0'].at, now - 24 * 36e5, 'offline does not rewrite timestamps');
  } finally { rm(root); }
});

test('saved complete dependency brief expires at its freshness deadline while preserving checked age', () => {
  const { root, out } = project();
  try {
    const store = { records: [{ kind: 'dependency', dev: false, flags: [] }], stamp: { stats: { depsFingerprint: 'same' } } };
    const now = Date.now();
    const cache = loadCache(out);
    cache.summary = { at: now - 1000, validUntil: now, checked: 1, vulnerable: 0, high: 0, deprecated: 0, fingerprint: 'same', complete: true };
    saveCache(out, cache);
    assert.match(depsSummary(out, store, now - 1), /checked/);
    assert.match(depsSummary(out, store, now), /partially checked/);
    assert.match(depsSummary(out, store, now), /oldest data 1 min ago/);
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

// Trimmed from the live public OSV record at https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm.
test('a trimmed real OSV response keeps the advisory severity and fixed version', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/osv-lodash-ghsa-35jh-r3h4-6jhm.json', import.meta.url), 'utf8'));
  const v = slimVuln(raw);
  assert.equal(v.id, 'GHSA-35jh-r3h4-6jhm');
  assert.equal(v.summary, 'Command Injection in lodash');
  assert.equal(v.severity, 'HIGH');
  assert.equal(fixedIn(v, 'lodash', '4.17.15'), '4.17.21');
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

test('docs DNS answers are checked as one set before a socket is opened, including mixed and mapped addresses', async () => {
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(fetchText('https://rebind.test/docs', { resolve }), /not a public address/);
  for (const host of ['https://[::ffff:7f00:1]/', 'https://[2001:db8::1]/', 'https://[ff02::1]/', 'https://192.0.2.1/']) {
    await assert.rejects(assertPublicUrl(host), /not a public address/);
  }
});

test('HTTPS requests retain default TLS hostname verification, and redirects revalidate private destinations', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: 'https://private.test/path' }); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(fetchText(base, { trusted: true, resolve: async () => [{ address: '10.0.0.1', family: 4 }] }), /not a public address/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  // The HTTPS request uses https.request with hostname=the URL host and default rejectUnauthorized=true;
  // the custom lookup only changes the socket destination, not TLS SNI/certificate name checking.
  const source = readFileSync(new URL('../src/net.mjs', import.meta.url), 'utf8');
  assert.match(source, /const transport = u\.protocol === 'https:' \? httpsRequest/);
  assert.match(source, /hostname: host/);
  assert.doesNotMatch(source, /rejectUnauthorized:\s*false/);
});

test('fetchText keeps timeout and response size caps on pinned requests, including a total streaming deadline', async () => {
  const server = http.createServer((_req, res) => { res.write('123456'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(fetchText(url, { trusted: true, maxBytes: 3 }), /response exceeds 3 bytes/);
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  const slow = http.createServer(() => {});
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(fetchText(`http://127.0.0.1:${slow.address().port}`, { trusted: true, timeoutMs: 20 }), /timed out/); }
  finally { slow.closeAllConnections?.(); await new Promise((resolve) => slow.close(resolve)); }

  let ticks = 0;
  let streamTimer;
  const streaming = http.createServer((_req, res) => {
    streamTimer = setInterval(() => { ticks++; res.write('x'); }, 30);
  });
  await new Promise((resolve) => streaming.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchText(`http://127.0.0.1:${streaming.address().port}`, { trusted: true, timeoutMs: 180, maxBytes: 100 }), /timed out/);
    assert.ok(ticks >= 3, 'bytes arrived repeatedly before the total deadline');
    assert.ok(ticks < 100, 'the test stream stayed under the response size cap');
  } finally { clearInterval(streamTimer); streaming.closeAllConnections?.(); await new Promise((resolve) => streaming.close(resolve)); }
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
    assert.match(depsSummary(out, store), /^Dependencies: 4 direct \(1 dev\), 1 possibly unused; 0 vulnerable.*partially checked/);

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

test('new docs notes label both source paths as current at fetch time and version compatibility unverified', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const cache = loadCache(out);
    cache.npm['lodash@4.17.15'] = { homepage: 'https://lodash.example', repo: 'https://github.com/lodash/lodash.git', at: Date.now() };
    cache.npm['left-pad@1.3.0'] = { homepage: null, repo: 'https://github.com/example/left-pad.git', at: Date.now() };
    saveCache(out, cache);
    const llmsFetcher = async (url) => url.endsWith('/llms.txt') ? { url, text: '# lodash\n[Debounce](https://lodash.example/debounce.md)\n', type: 'text/plain' } : url.endsWith('debounce.md') ? { url, text: '# Debounce\nUse debounce safely.\n', type: 'text/markdown' } : null;
    const homepage = await docsFor({ out, memory, name: 'lodash', version: '4.17.15', query: 'debounce', policy: { allowed: true }, fetcher: llmsFetcher });
    assert.match(homepage, /source fetched at .*compatibility with installed 4\.17\.15 is unverified/);
    assert.match(homepage, /from llms\.txt/);

    const githubFetcher = async (url) => url.includes('raw.githubusercontent.com') ? { url, text: '# README\nUse left pad.\n', type: 'text/markdown' } : null;
    const github = await docsFor({ out, memory, name: 'left-pad', version: '1.3.0', query: 'pad', policy: { allowed: true }, fetcher: githubFetcher });
    assert.match(github, /from README \(example\/left-pad\)/);
    assert.match(github, /source fetched at .*compatibility with installed 1\.3\.0 is unverified/);

    memory.remember({ title: 'docs: lodash@4.17.15 - legacy', body: 'Legacy body.', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.15' }] });
    const legacyOffline = await docsFor({ out, memory, name: 'lodash', version: '4.17.15', query: 'legacy', policy: { allowed: false, why: 'offline.' } });
    assert.match(legacyOffline, /source was current when fetched; compatibility with installed 4\.17\.15 is unverified/);
    assert.match(legacyOffline, /Legacy body/);
  } finally { await fake.close(); rm(root); }
});

test('a lockfile-only version change invalidates the map and makes its docs note stale', async () => {
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const memory = createMemory({ root, dir: path.join(out, 'memory'), versionOf: versionOfFrom(() => loadStore(out)) });
    memory.remember({ title: 'docs: lodash@4.17.15 - debounce', body: 'Use debounce.', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.15' }] });
    assert.equal(isFresh(root, out), true);

    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/lodash'].version = '4.17.21';
    write(root, 'package-lock.json', JSON.stringify(lock));
    assert.equal(isFresh(root, out), false, 'the lockfile is excluded from mapped file records but still controls freshness');

    await buildMap({ root, out });
    assert.equal(memory.list()[0].status, 'stale');
    assert.match(memory.list()[0].anchorStates[0].detail, /lodash is now 4\.17\.21/);
    assert.notEqual(loadStore(out).stamp.stats.depsLockSig, null);
    const note = await docsFor({ out, memory, name: 'lodash', version: '4.17.21', query: 'debounce', policy: { allowed: false, why: 'Network lookups are off.' } });
    assert.match(note, /saved note .* stale/);
    assert.match(note, /This note is out of date for the installed version/);
  } finally { rm(root); }
});

test('dependency manifest add, remove, and range edits invalidate complete summaries with the lock unchanged', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    let store = loadStore(out);
    const originalLockSig = store.stamp.stats.depsLockSig;
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const check = async () => {
      await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
      assert.equal(loadCache(out).summary.complete, true);
      const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      const before = (await import('node:fs')).statSync(path.join(root, 'package.json'));
      const update = (fn) => {
        fn(manifest);
        write(root, 'package.json', JSON.stringify(manifest));
        utimesSync(path.join(root, 'package.json'), before.atime, before.mtime);
      };
      return { update };
    };

    let { update } = await check();
    update((m) => { m.optionalDependencies = { ...(m.optionalDependencies ?? {}), lodash: '^4.17.0' }; });
    assert.equal(isFresh(root, out), false, 'same lock signature does not hide a manifest add');
    await buildMap({ root, out });
    store = loadStore(out);
    assert.equal(store.stamp.stats.depsLockSig, originalLockSig);
    assert.match(depsSummary(out, store), /manifests or lockfiles changed/);

    ({ update } = await check());
    update((m) => { delete m.optionalDependencies.lodash; });
    assert.equal(isFresh(root, out), false, 'manifest removal invalidates map freshness');
    await buildMap({ root, out });
    store = loadStore(out);
    assert.equal(store.stamp.stats.depsLockSig, originalLockSig);
    assert.match(depsSummary(out, store), /manifests or lockfiles changed/);

    ({ update } = await check());
    update((m) => { m.dependencies.lodash = '^4.18.0'; });
    assert.equal(isFresh(root, out), false, 'same-size range changes are detected despite restored mtime');
    await buildMap({ root, out });
    store = loadStore(out);
    assert.equal(store.stamp.stats.depsLockSig, originalLockSig);
    assert.match(depsSummary(out, store), /manifests or lockfiles changed/);
  } finally { await fake.close(); rm(root); }
});

test('missing-to-present governing lockfiles rebuild the map, and legacy summaries are rejected', async () => {
  const { root, out } = project();
  try {
    rmSync(path.join(root, 'package-lock.json'));
    await buildMap({ root, out });
    assert.equal(isFresh(root, out), true);
    write(root, 'package-lock.json', JSON.stringify(LOCK));
    assert.equal(isFresh(root, out), false, 'a newly present lockfile changes dependency input state');
    await buildMap({ root, out });
    const store = loadStore(out);
    const cache = loadCache(out);
    cache.summary = { at: Date.now(), checked: 1, vulnerable: 0, high: 0, deprecated: 0, sig: store.stamp.stats.depsLockSig, complete: true };
    saveCache(out, cache);
    assert.match(depsSummary(out, store), /legacy/);
    assert.doesNotMatch(depsSummary(out, store), /checked \d/);
  } finally { rm(root); }
});

test('--only unused keeps its no-advisory lookup behavior', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: { only: 'unused' }, allowOnline: true });
    assert.match(result, /Possibly unused production dependencies.*left-pad/);
    assert.deepEqual(fake.hits, { osv: 0, npm: 0, vuln: 0 });
    assert.equal(loadCache(out).summary, null);
  } finally { await fake.close(); rm(root); }
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

test('doctor reports the effective network policy and the advisory cache age: missing, fresh, stale, forced offline', () => {
  const { root, out } = project();
  try {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const env = {};
    let r = doctor(root, { env, now });
    assert.match(r.text, /Network policy: off by default/);
    assert.match(r.text, /Advisory cache: none yet/);

    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'deps-cache.json'), JSON.stringify({ v: 1, osv: { 'lodash@4.17.15': { ids: [], at: now - 2 * 36e5 } }, vulns: {}, npm: {}, summary: null }));
    r = doctor(root, { env, now });
    assert.match(r.text, /Advisory cache: newest 2 h old, oldest 2 h old, fresh/);

    r = doctor(root, { env, now: now + 30 * 36e5 });
    assert.match(r.text, /Advisory cache: newest 32 h old, oldest 32 h old, stale/);

    write(root, 'map-it-all.config.json', JSON.stringify({ network: true }));
    assert.match(doctor(root, { env, now }).text, /Network policy: on: "network": true in the config/);
    assert.match(doctor(root, { env: { MAP_IT_ALL_OFFLINE: '1' }, now }).text, /Network policy: forced off by MAP_IT_ALL_OFFLINE=1/);
    assert.match(doctor(root, { env: { MAP_IT_ALL_OFFLINE: '1' }, now }).text, /Advisory cache: newest 2 h old, oldest 2 h old, fresh/, 'cache age still shows when forced offline');
  } finally { rm(root); }
});

test('doctor cache age handles mixed ages and the exact 24 h boundary', () => {
  const { root, out } = project();
  try {
    const now = Date.parse('2026-11-16T12:00:00Z');
    mkdirSync(out, { recursive: true });
    const at = (hours) => now - hours * 36e5;
    const cache = (...hrs) => writeFileSync(path.join(out, 'deps-cache.json'), JSON.stringify({ v: 1, osv: Object.fromEntries(hrs.map((h, i) => [`p${i}@1.0.0`, { ids: [], at: at(h) }])), vulns: {}, npm: {}, summary: null }));
    const text = () => doctor(root, { env: {}, now }).text;

    cache(1, 30);
    assert.match(text(), /Advisory cache: newest 1 h old, oldest 30 h old, mixed: 1 of 2 entries are 24 h or older/);
    cache(23.99);
    assert.match(text(), /Advisory cache: newest 23 h old, oldest 23 h old, fresh/);
    cache(24);
    assert.match(text(), /Advisory cache: newest 24 h old, oldest 24 h old, stale/, 'exactly 24 h is stale, matching the lookup rule');
  } finally { rm(root); }
});

test('an empty-query docs lookup offline still shows a stale pinned note, with a warning', async () => {
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const memory = createMemory({ root, dir: path.join(out, 'memory'), versionOf: versionOfFrom(() => loadStore(out)) });
    memory.remember({ title: 'docs: lodash@4.17.10', body: 'Old overview.', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.10' }] });
    const note = await docsFor({ out, memory, name: 'lodash', version: '4.17.15', policy: { allowed: false, why: 'Network lookups are off.' } });
    assert.match(note, /docs: lodash@4\.17\.10/);
    assert.match(note, /stale/);
    assert.match(note, /Old overview/);
    assert.match(note, /out of date for the installed version/);
    const none = await docsFor({ out, memory, name: 'left-pad', version: '1.3.0', policy: { allowed: false, why: 'off.' } });
    assert.match(none, /No saved docs for left-pad@1\.3\.0/);
  } finally { rm(root); }
});

test('a gitignored lockfile still governs freshness', async () => {
  const { root, out } = project();
  try {
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', 'package.json', 'src');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
    write(root, '.gitignore', 'package-lock.json\n.map-it-all/\n');
    assert.equal(git('check-ignore', 'package-lock.json').status, 0, 'the lockfile is ignored');
    await buildMap({ root, out });
    assert.equal(isFresh(root, out), true);
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/lodash'].version = '4.17.21';
    write(root, 'package-lock.json', JSON.stringify(lock));
    assert.equal(isFresh(root, out), false, 'an ignored lockfile-only change rebuilds');
  } finally { rm(root); }
});

// A fake OSV/registry that counts requests and can fail advisory-detail requests on demand.
async function fakeOsv({ ids }) {
  const hits = { osv: 0, npm: 0, vuln: 0 };
  const state = { ids: [...ids], detailSummary: 'Remote code execution', npmMetadata: {}, failDetails: false, failBatch: false, batchResponse: null, failIds: new Set(), seen: [], failNpm: new Set(), notFoundNpm: new Set(), npmSeen: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/querybatch') { hits.osv++; if (state.failBatch) { res.statusCode = 500; res.end('{}'); return; } const queries = JSON.parse(body).queries; res.end(JSON.stringify(state.batchResponse ? state.batchResponse(queries) : { results: queries.map((q) => (q.package.name === 'lodash' ? { vulns: state.ids.map((id) => ({ id })) } : {})) })); }
      else if (req.url.startsWith('/v1/vulns/')) {
        hits.vuln++;
        const vid = decodeURIComponent(req.url.slice(10));
        state.seen.push(vid);
        if (state.failDetails || state.failIds.has(vid)) { res.statusCode = 500; res.end('{}'); return; }
        res.end(JSON.stringify({ id: decodeURIComponent(req.url.slice(10)), summary: state.detailSummary, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }));
      } else { hits.npm++; state.npmSeen.push(req.url); if (state.notFoundNpm.has(req.url.split('/')[1])) { res.statusCode = 404; res.end('{}'); return; } if (state.failNpm.has(req.url.split('/')[1])) { res.statusCode = 500; res.end('{}'); return; } res.end(JSON.stringify(state.npmMetadata)); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.MAP_IT_ALL_OSV_URL = base;
  process.env.MAP_IT_ALL_NPM_URL = base;
  return { hits, state, close: async () => { delete process.env.MAP_IT_ALL_OSV_URL; delete process.env.MAP_IT_ALL_NPM_URL; await new Promise((r) => server.close(r)); } };
}

test('fully resolved clean lockfile retains the clean advisory result', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /No known vulnerabilities for the installed versions/);
    assert.equal(loadCache(out).summary.complete, true);
    assert.match(depsSummary(out, store), /checked/);
    assert.doesNotMatch(depsSummary(out, store), /partially checked/);
  } finally { await fake.close(); rm(root); }
});

test('fully resolved Yarn lockfile retains clean advisory behavior', async () => {
  const fake = await fakeOsv({ ids: [] });
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-yarn-'));
  const out = path.join(root, '.map-it-all');
  try {
    write(root, 'package.json', JSON.stringify({ name: 'yarn-app', dependencies: { lodash: '^4.17.0' } }));
    write(root, 'yarn.lock', ['# yarn lockfile v1', '', 'lodash@^4.17.0:', '  version "4.17.15"', ''].join('\n'));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const result = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(result, /No known vulnerabilities for the installed versions/);
    assert.equal(loadCache(out).summary.complete, true);
    assert.match(depsSummary(out, store), /checked/);
  } finally { await fake.close(); rm(root); }
});

test('online package detail invalidates map-wide summary until a list run recomputes it', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.equal(loadCache(out).summary.complete, true);
    const original = depsSummary(out, store);

    await runDeps({ root, out, store, memory, config, args: { package: 'lodash' }, allowOnline: false });
    assert.equal(depsSummary(out, store), original, 'offline detail keeps a valid map-wide result');
    await runDeps({ root, out, store, memory, config, args: { package: 'does-not-exist' }, allowOnline: true });
    assert.equal(depsSummary(out, store), original, 'unmatched package does not invalidate the result');

    fake.state.failBatch = true;
    fake.state.failNpm.add('lodash');
    const failed = await runDeps({ root, out, store, memory, config, args: { package: 'lodash', refresh: true }, allowOnline: true });
    assert.match(failed, /OSV lookup failed/);
    assert.match(failed, /refresh failed/);
    assert.equal(loadCache(out).summary, null);
    assert.match(depsSummary(out, store), /map-wide advisory check unavailable.*run `deps`/);
    fake.state.failBatch = false;
    fake.state.failNpm.clear();
    await runDeps({ root, out, store, memory, config, args: { package: 'lodash' }, allowOnline: true });
    assert.equal(loadCache(out).summary, null, 'detail recovery alone cannot validate the whole map');
    assert.match(depsSummary(out, store), /map-wide advisory check unavailable/);
    await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.equal(loadCache(out).summary.complete, true);
    assert.match(depsSummary(out, store), /checked/);

    fake.state.failNpm.add('eslint');
    await runDeps({ root, out, store, memory, config, args: { refresh: true }, allowOnline: true });
    assert.equal(loadCache(out).summary.complete, false, 'list refresh records a partial result');
    assert.match(depsSummary(out, store), /partially checked/);
    await runDeps({ root, out, store, memory, config, args: { package: 'lodash' }, allowOnline: true });
    assert.equal(loadCache(out).summary, null, 'detail invalidates a partial list result too');
    assert.match(depsSummary(out, store), /map-wide advisory check unavailable/);
  } finally { await fake.close(); rm(root); }
});

test('online package detail refresh updates cached advisory data and requires a new list-wide brief', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.equal(loadCache(out).summary.complete, true);
    assert.equal(loadCache(out).summary.vulnerable, 0);
    assert.match(depsSummary(out, store), /0 vulnerable/);

    fake.state.ids = ['GHSA-updated'];
    fake.state.detailSummary = 'Newly discovered advisory';
    const detail = await runDeps({ root, out, store, memory, config, args: { package: 'lodash', refresh: true }, allowOnline: true });
    assert.match(detail, /GHSA-updated/);
    assert.match(detail, /Newly discovered advisory/);
    assert.deepEqual(loadCache(out).osv['lodash@4.17.15'].ids, ['GHSA-updated'], 'detail refresh stores the changed package lookup');
    assert.equal(loadCache(out).vulns['GHSA-updated'].summary, 'Newly discovered advisory', 'detail refresh stores changed advisory content');
    assert.equal(loadCache(out).summary, null, 'a package refresh cannot validate the map-wide brief');
    assert.match(depsSummary(out, store), /map-wide advisory check unavailable/);

    const list = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(list, /GHSA-updated/);
    assert.equal(loadCache(out).summary.complete, true, 'the list recomputes completeness for the full map');
    assert.equal(loadCache(out).summary.vulnerable, 1, 'the recomputed result includes the changed advisory');
    assert.match(depsSummary(out, store), /1 vulnerable/);
    assert.match(depsSummary(out, store), /checked/);
  } finally { await fake.close(); rm(root); }
});

test('OSV querybatch rejects malformed cardinality and exhausted pagination without committing partial pages', async () => {
  const modes = ['missing', 'short', 'oversized', 'pagination'];
  for (const mode of modes) {
    const fake = await fakeOsv({ ids: ['GHSA-old'] });
    const { root, out } = project();
    try {
      await buildMap({ root, out });
      const store = loadStore(out);
      const config = loadConfig(root);
      const memory = createMemory({ root, dir: path.join(out, 'memory') });
      await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
      const cache = loadCache(out);
      for (const entry of Object.values(cache.osv)) entry.at = 0;
      saveCache(out, cache);
      const previousOsv = structuredClone(cache.osv);
      const previousVulns = structuredClone(cache.vulns);
      assert.deepEqual(previousOsv['lodash@4.17.15'].ids, ['GHSA-old'], `${mode}: fixture has a cached positive result`);
      assert.ok(Object.values(previousOsv).some((entry) => entry.ids.length === 0), `${mode}: fixture has a cached empty result`);
      let pages = 0;
      fake.state.batchResponse = (queries) => {
        pages++;
        if (mode === 'pagination') return pages === 1
          ? { results: queries.map((_, i) => i === 0 ? { vulns: [{ id: 'GHSA-new' }], next_page_token: 'next' } : {}) }
          : { results: [] };
        if (mode === 'missing') return {};
        if (mode === 'short') return { results: queries.slice(1).map(() => ({})) };
        return { results: [...queries.map(() => ({})), {}] };
      };
      const failed = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
      assert.match(failed, /OSV lookup failed/);
      assert.deepEqual(loadCache(out).osv, previousOsv, `${mode}: old OSV data and timestamps survive`);
      assert.deepEqual(loadCache(out).vulns, previousVulns, `${mode}: old advisory details survive`);
      assert.deepEqual(Object.keys(loadCache(out).osvFailed).sort(), Object.keys(previousOsv).sort(), `${mode}: every stale target gets a retry marker`);
      assert.equal(loadCache(out).summary.complete, false, `${mode}: list result is partial`);

      const beforeOffline = fake.hits.osv;
      const offline = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
      assert.equal(fake.hits.osv, beforeOffline, `${mode}: offline follow-up makes no request`);
      assert.match(depsSummary(out, store), /partially checked/);
      assert.match(offline, /package lookup\(s\) failed|not checked yet|No known vulnerabilities/);

      fake.state.batchResponse = null;
      await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
      assert.equal(Object.keys(loadCache(out).osvFailed).length, 0, `${mode}: ordinary retry clears lookup markers`);
      assert.equal(loadCache(out).summary.complete, true, `${mode}: successful retry restores complete list summary`);
    } finally { await fake.close(); rm(root); }
  }
});

test('OSV exact-cardinality continuation tokens exhaust all four pagination rounds and recover online', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-old'] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });

    const cache = loadCache(out);
    for (const entry of Object.values(cache.osv)) entry.at = 0;
    saveCache(out, cache);
    const previousOsv = structuredClone(cache.osv);
    const previousVulns = structuredClone(cache.vulns);
    assert.ok(Object.values(previousOsv).some((entry) => entry.ids.length === 0), 'fixture includes a cached empty lookup');

    const roundTokens = [];
    fake.state.batchResponse = (queries) => {
      const round = roundTokens.length + 1;
      const tokens = queries.map((q) => q.page_token ?? 'first');
      const results = queries.map((q, i) => ({
        ...(round === 1 && q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-uncommitted' }] } : {}),
        next_page_token: `round-${round}-item-${i}`,
      }));
      roundTokens.push({ queryCount: queries.length, resultCount: results.length, tokens });
      return { results };
    };
    const failed = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.match(failed, /OSV lookup failed/);
    assert.match(failed, /pagination still had .* after 4 rounds/);
    assert.equal(roundTokens.length, 4, 'all four allowed rounds were requested');
    assert.ok(roundTokens.every((round) => round.queryCount > 0 && round.queryCount === round.resultCount), 'every round returned exact-cardinality results');
    assert.ok(roundTokens.every((round) => round.tokens.length === round.queryCount && round.tokens.every(Boolean)), 'every result in every round carried a continuation token');
    assert.deepEqual(loadCache(out).osv, previousOsv, 'exhaustion retains all prior lookups and timestamps, including cached empty data');
    assert.deepEqual(loadCache(out).vulns, previousVulns, 'uncommitted pages do not replace prior advisory details');
    assert.deepEqual(Object.keys(loadCache(out).osvFailed).sort(), Object.keys(previousOsv).sort(), 'all stale targets receive retry markers');
    assert.equal(loadCache(out).summary.complete, false);

    const beforeOffline = { ...fake.hits };
    const offline = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.deepEqual(fake.hits, beforeOffline, 'offline follow-up makes no network request');
    assert.match(offline, /partial: .*package lookup\(s\) failed/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);

    fake.state.batchResponse = null;
    const recovered = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.doesNotMatch(recovered, /partial: .*package lookup\(s\) failed/);
    assert.equal(Object.keys(loadCache(out).osvFailed).length, 0, 'ordinary online success clears retry markers');
    assert.equal(loadCache(out).summary.complete, true);
    assert.match(depsSummary(out, store), /checked/);
  } finally { await fake.close(); rm(root); }
});

test('OSV exact-cardinality empty result objects are clean no-vulnerability results', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = [{ name: 'safe-a', version: '1.0.0' }, { name: 'safe-b', version: '2.0.0' }];
    fake.state.batchResponse = (queries) => ({ results: queries.map(() => ({})) });
    const result = await advisoriesFor({ out, targets, online: true });
    assert.equal(result.stale, 0);
    assert.equal(result.missing, 0);
    assert.deepEqual([...result.byKey.values()], [[], []]);
    assert.deepEqual(loadCache(out).osv['safe-a@1.0.0'].ids, []);
    assert.deepEqual(loadCache(out).osv['safe-b@2.0.0'].ids, []);
  } finally { await fake.close(); rm(root); }
});

test('fresh cached OSV lookup retries a failed forced refresh until success', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-old'] });
  const { root, out } = project();
  const targets = [{ name: 'lodash', version: '4.17.15' }];
  try {
    await advisoriesFor({ out, targets, online: true });
    fake.state.ids = ['GHSA-new'];
    fake.state.failBatch = true;
    const failed = await advisoriesFor({ out, targets, online: true, force: true });
    assert.equal(failed.staleKeys.size, 1);
    assert.match(failed.error, /OSV lookup failed/);
    assert.ok(loadCache(out).osvFailed['lodash@4.17.15']);
    const beforeOffline = fake.hits.osv;
    const offline = await advisoriesFor({ out, targets, online: false });
    assert.equal(fake.hits.osv, beforeOffline, 'offline makes no request');
    assert.equal(offline.staleKeys.size, 1, 'the fresh cached lookup remains partial offline');

    fake.state.failBatch = false;
    const recovered = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.osv, beforeOffline + 1, 'ordinary online run retries the fresh lookup');
    assert.equal(recovered.staleKeys.size, 0);
    assert.deepEqual(loadCache(out).osv['lodash@4.17.15'].ids, ['GHSA-new']);
    assert.equal(loadCache(out).osvFailed['lodash@4.17.15'], undefined, 'success clears only the lookup marker');
    assert.equal(recovered.stale, 0, 'partial status recovers');
  } finally { await fake.close(); rm(root); }
});

test('fresh cached advisory detail retries a failed forced refresh until success', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-aaaa'] });
  const { root, out } = project();
  const targets = [{ name: 'lodash', version: '4.17.15' }];
  try {
    await advisoriesFor({ out, targets, online: true });
    fake.state.detailSummary = 'Updated advisory summary';
    fake.state.failDetails = true;
    const failed = await advisoriesFor({ out, targets, online: true, force: true });
    assert.equal(failed.failedDetails, 1);
    assert.ok(loadCache(out).tried['GHSA-aaaa']);
    const beforeOffline = fake.hits.vuln;
    const offline = await advisoriesFor({ out, targets, online: false });
    assert.equal(fake.hits.vuln, beforeOffline, 'offline makes no request');
    assert.equal(offline.failedDetails, 1, 'the fresh cached detail remains partial offline');

    fake.state.failDetails = false;
    const recovered = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.vuln, beforeOffline + 1, 'ordinary online run retries the fresh detail');
    assert.equal(recovered.failedDetails, 0);
    assert.equal(recovered.staleDetails, 0, 'partial status recovers');
    assert.equal(loadCache(out).vulns['GHSA-aaaa'].summary, 'Updated advisory summary');
    assert.equal(loadCache(out).tried['GHSA-aaaa'], undefined, 'success clears the detail marker');
  } finally { await fake.close(); rm(root); }
});

test('fresh cached npm metadata retries a failed forced refresh until success', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  const targets = [{ name: 'lodash', version: '4.17.15' }];
  try {
    fake.state.npmMetadata = { deprecated: 'old notice', homepage: 'https://old.example' };
    await registryFor({ out, targets, online: true });
    fake.state.failNpm.add('lodash');
    const failed = await registryFor({ out, targets, online: true, force: true });
    assert.equal(failed.failed, 1);
    assert.ok(loadCache(out).npmTried['lodash@4.17.15']);
    const beforeOffline = fake.hits.npm;
    const offline = await registryFor({ out, targets, online: false });
    assert.equal(fake.hits.npm, beforeOffline, 'offline makes no request');
    assert.equal(offline.failed, 1, 'the fresh cached target remains partial offline');

    fake.state.failNpm.clear();
    fake.state.npmMetadata = { deprecated: 'updated notice', homepage: 'https://new.example' };
    const recovered = await registryFor({ out, targets, online: true });
    assert.equal(fake.hits.npm, beforeOffline + 1, 'ordinary online run retries the fresh target');
    assert.equal(recovered.failed, 0, 'partial status recovers');
    assert.equal(recovered.byKey.get('lodash@4.17.15').deprecated, 'updated notice');
    assert.equal(loadCache(out).npmTried['lodash@4.17.15'], undefined, 'success clears the target marker');
  } finally { await fake.close(); rm(root); }
});

test('a failed advisory-detail request is partial, never clean, and the next online run retries it from the cached package ids', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-aaaa'] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const run = () => runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });

    fake.state.failDetails = true;
    const failed = await run();
    assert.equal(fake.hits.osv, 1);
    assert.match(failed, /partial: \d+ advisory detail\(s\) failed to fetch/);
    assert.doesNotMatch(failed, /not fetched yet \(at most/, 'a failed request is not described as not attempted');
    assert.match(failed, /GHSA-aaaa.*details not fetched yet/s, 'the unresolved advisory id stays visible');
    assert.doesNotMatch(failed, /No known vulnerabilities/);
    assert.doesNotMatch(failed, /checked \d+ (min|h|d) ago/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.equal(loadCache(out).osv['lodash@4.17.15'].ids[0], 'GHSA-aaaa', 'package ids were cached');

    const offline = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.match(offline, /partial: \d+ advisory detail\(s\) failed to fetch/);
    assert.doesNotMatch(offline, /No known vulnerabilities/);
    assert.match(depsSummary(out, store), /partially checked/);
    assert.equal(fake.hits.vuln, 1, 'the separate offline invocation does not retry');

    fake.state.failDetails = false;
    const osvBefore = fake.hits.osv;
    const retried = await run();
    assert.equal(fake.hits.osv, osvBefore, 'the retry reuses the cached package ids');
    assert.doesNotMatch(retried, /partial|details not fetched/);
    assert.match(retried, /Remote code execution/);
    assert.equal(loadCache(out).summary.complete, true);

    const vulnBefore = fake.hits.vuln;
    await run();
    assert.equal(fake.hits.vuln, vulnBefore, 'once resolved, details are served from the cache');
  } finally { await fake.close(); rm(root); }
});

test('an expired advisory detail whose refresh fails is kept rather than dropped', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-aaaa'] });
  const { root, out } = project();
  try {
    const t = [{ name: 'lodash', version: '4.17.15' }];
    await advisoriesFor({ out, targets: t, online: true });
    const cache = loadCache(out);
    cache.vulns['GHSA-aaaa'].at -= 8 * 24 * 36e5; // expired (7 d lifetime)
    saveCache(out, cache);
    fake.state.failDetails = true;
    const r = await advisoriesFor({ out, targets: t, online: true });
    assert.equal(r.unresolved, 0);
    assert.equal(r.byKey.get('lodash@4.17.15')[0].summary, 'Remote code execution', 'previous valid detail preserved');
    assert.ok(r.error, 'the failed refresh is still reported');
  } finally { await fake.close(); rm(root); }
});

test('more than 300 new advisory ids: the excess is reported as partial and finished by the next run', async () => {
  const ids = Array.from({ length: 305 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    const first = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.vuln, 300, 'at most 300 detail requests per run');
    assert.equal(first.unresolved, 5);
    assert.match(first.error, /5 advisory detail\(s\) deferred by the 300-item per-run cap/);
    const list = first.byKey.get('lodash@4.17.15');
    assert.equal(list.length, 305, 'every id stays visible');
    assert.equal(list.filter((v) => v.unresolved).length, 5);

    const second = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.osv, 1, 'package ids were not requested again');
    assert.equal(fake.hits.vuln, 305, 'only the remaining 5 were fetched');
    assert.equal(second.unresolved, 0);
    assert.equal(second.error, null);
    assert.equal(second.byKey.get('lodash@4.17.15').filter((v) => v.unresolved).length, 0);

    const offline = await advisoriesFor({ out, targets, online: false });
    assert.equal(offline.unresolved, 0);
    assert.equal(fake.hits.vuln, 305, 'offline makes no request');
  } finally { await fake.close(); rm(root); }
});

test('ids that keep failing cannot starve later ids across runs, and no id is requested twice in a run', async () => {
  const ids = Array.from({ length: 305 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    for (const id of ids.slice(0, 300)) fake.state.failIds.add(id); // the whole first page fails persistently
    const first = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.state.seen.length, 300);
    assert.equal(new Set(fake.state.seen).size, 300, 'no duplicate detail requests in a run');
    assert.equal(first.unresolved, 305);
    fake.state.seen.length = 0;
    const second = await advisoriesFor({ out, targets, online: true });
    assert.deepEqual(fake.state.seen.slice(0, 5), ids.slice(300), 'the unattempted ids go first on the next run');
    assert.equal(new Set(fake.state.seen).size, fake.state.seen.length);
    assert.equal(second.unresolved, 300, 'the later ids resolved although the first page keeps failing');
    assert.ok(loadCache(out).vulns[ids[304]]);
  } finally { await fake.close(); rm(root); }
});

test('missing and expired advisory details share one queue under the 300-item cap', async () => {
  const ids = Array.from({ length: 610 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    const cache = loadCache(out);
    cache.osv['lodash@4.17.15'] = { ids, at: Date.now() };
    for (const id of ids.slice(0, 305)) cache.vulns[id] = { id, aliases: [], summary: 'old', severity: 'LOW', score: 1, malware: false, withdrawn: false, fixed: {}, at: Date.now() - 8 * 24 * 36e5 };
    saveCache(out, cache);
    await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.state.seen.length, 300);
    assert.deepEqual(fake.state.seen, ids.slice(305, 605), 'first run takes the never-attempted ids');
    fake.state.seen.length = 0;
    await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.state.seen.length, 300);
    assert.deepEqual(fake.state.seen, [...ids.slice(605), ...ids.slice(0, 295)], 'one queue: the never-attempted ids first, then the oldest expired records, so cached ids are not starved');
  } finally { await fake.close(); rm(root); }
});

test('registry cap rotates through more than 300 missing versions and reports deferred coverage', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = Array.from({ length: 305 }, (_, i) => ({ name: `package-${i}`, version: '1.0.0' }));
    const first = await registryFor({ out, targets, online: true });
    assert.equal(first.deferred, 5);
    assert.equal(fake.hits.npm, 300);
    const second = await registryFor({ out, targets, online: true });
    assert.equal(second.deferred, 0);
    assert.equal(fake.hits.npm, 305);
  } finally { await fake.close(); rm(root); }
});

test('a failed package refresh over a cached empty lookup is stale: no clean claim, summary incomplete, brief says partially checked', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const run = (args = {}) => runDeps({ root, out, store, memory, config, args, allowOnline: true });
    const clean = await run();
    assert.match(clean, /No known vulnerabilities/);
    assert.equal(loadCache(out).summary.complete, true);
    const cache = loadCache(out);
    for (const e of Object.values(cache.osv)) e.at -= 25 * 36e5; // expired
    saveCache(out, cache);
    fake.state.failBatch = true;
    const failed = await run();
    assert.doesNotMatch(failed, /No known vulnerabilities/);
    assert.match(failed, /partial: 5 package lookup\(s\) failed to refresh/);
    assert.match(failed, /OSV lookup failed/);
    assert.equal(loadCache(out).summary.complete, false);
    const brief = depsSummary(out, store);
    assert.match(brief, /partially checked \(oldest data/);
    assert.doesNotMatch(brief, /, checked \d/);
    assert.ok(brief.indexOf('partially checked') < brief.indexOf('ago'), 'the partial wording comes before any age');
    const detail = await run({ package: 'lodash' });
    assert.doesNotMatch(detail, /no known advisories/);
    assert.match(detail, /not confirmed/);
    // an intervening offline run keeps the failure: stale cached-empty data never turns clean or complete
    fake.state.failBatch = false;
    const hitsBefore = { ...fake.hits };
    const offlineRun = (args = {}) => runDeps({ root, out, store, memory, config, args, allowOnline: false });
    const offline = await offlineRun();
    assert.deepEqual(fake.hits, hitsBefore, 'offline makes no request');
    assert.doesNotMatch(offline, /No known vulnerabilities/);
    assert.match(offline, /partial: 5 package lookup\(s\) failed to refresh/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
    assert.match(await offlineRun({ package: 'lodash' }), /not confirmed/);
  } finally { await fake.close(); rm(root); }
});

test('an expired withdrawn detail whose refresh fails is stale, not clean, and the brief says partially checked', async () => {
  const fake = await fakeOsv({ ids: ['GHSA-aaaa'] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const run = () => runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    await run();
    const cache = loadCache(out);
    cache.vulns['GHSA-aaaa'].withdrawn = true;
    cache.vulns['GHSA-aaaa'].at -= 8 * 24 * 36e5;
    saveCache(out, cache);
    fake.state.failDetails = true;
    const failed = await run();
    assert.doesNotMatch(failed, /No known vulnerabilities/);
    assert.match(failed, /partial: 1 cached advisory detail\(s\) failed to refresh/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
    assert.equal(loadCache(out).vulns['GHSA-aaaa'].withdrawn, true, 'previous data preserved');
    // an intervening offline run keeps the failure: the stale withdrawn record never turns clean or complete
    const hitsBefore = fake.hits.vuln;
    const offline = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.equal(fake.hits.vuln, hitsBefore, 'offline makes no request');
    assert.doesNotMatch(offline, /No known vulnerabilities/);
    assert.match(offline, /partial: 1 cached advisory detail\(s\) failed to refresh/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);
    fake.state.failDetails = false;
    const ok = await run();
    assert.doesNotMatch(ok, /partial/, 'a successful refresh clears the stale state');
    assert.equal(loadCache(out).summary.complete, true);
  } finally { await fake.close(); rm(root); }
});

test('a capped detail refresh is pending, not failed, and says so; an offline read keeps that state', async () => {
  const ids = Array.from({ length: 305 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    await advisoriesFor({ out, targets, online: true });
    await advisoriesFor({ out, targets, online: true });
    const r = await advisoriesFor({ out, targets, online: true, force: true });
    assert.equal(r.pendingDetails, 5);
    assert.equal(r.failedDetails, 0);
    assert.doesNotMatch(r.error, /failed/);
    assert.match(r.error, /5 cached advisory detail\(s\) deferred by the 300-item per-run cap/);
    const offline = await advisoriesFor({ out, targets, online: false });
    assert.equal(offline.pendingDetails, 5, 'the pending state survives an offline run');
    assert.equal(offline.stale, 5);
  } finally { await fake.close(); rm(root); }
});

test('advisory-detail cap wins over legacy tried markers, including a shared unresolved ID, and clears on retry', async () => {
  const ids = Array.from({ length: 306 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  const targets = [{ name: 'lodash', version: '4.17.15' }];
  const now = 10_000;
  try {
    const cache = loadCache(out);
    cache.osv['lodash@4.17.15'] = { ids, at: now };
    for (const id of ids.slice(0, -1)) cache.vulns[id] = { id, at: now, summary: id, withdrawn: false };
    cache.tried['GHSA-0305'] = now + 0.5; // legacy failure is newer than the cached records
    cache.deferred['GHSA-0305'] = now;
    saveCache(out, cache);

    const capped = await advisoriesFor({ out, targets, online: true, force: true, now: now + 1 });
    assert.equal(fake.state.seen.length, 300);
    assert.equal(capped.pendingDetails, 5);
    assert.equal(capped.failedDetails, 0, 'deferred wins over a simultaneous tried marker');
    assert.equal(capped.staleDetails, 5);
    assert.equal(capped.unresolvedDeferred, 1, 'a shared unresolved ID is counted as deferred');
    assert.equal(capped.unresolvedFailed, 0, 'the same ID is not also counted failed');
    assert.ok(loadCache(out).tried['GHSA-0305'], 'cap does not erase failure history');
    assert.ok(loadCache(out).deferred['GHSA-0305']);

    const offline = await advisoriesFor({ out, targets, online: false, now: now + 2 });
    assert.equal(offline.pendingDetails, 5);
    assert.equal(offline.failedDetails, 0, 'persisted offline counts stay disjoint');
    assert.equal(offline.unresolvedDeferred, 1);
    assert.equal(offline.unresolvedFailed, 0);

    fake.state.seen.length = 0;
    const retried = await advisoriesFor({ out, targets, online: true, now: now + 3 });
    assert.equal(fake.state.seen.length, 6);
    assert.ok(fake.state.seen.includes('GHSA-0305'), 'the deferred unresolved ID is retried');
    assert.equal(retried.pendingDetails + retried.failedDetails, 0);
    assert.equal(retried.unresolvedDeferred + retried.unresolvedFailed, 0);
    assert.equal(loadCache(out).tried['GHSA-0305'], undefined);
    assert.equal(loadCache(out).deferred['GHSA-0305'], undefined);
  } finally { await fake.close(); rm(root); }
});

test('one combined detail queue: persistent failures on missing ids cannot starve cached refreshes, with no duplicate requests', async () => {
  const ids = Array.from({ length: 320 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    await advisoriesFor({ out, targets, online: true });
    await advisoriesFor({ out, targets, online: true }); // all 320 resolved
    const missingIds = ids.slice(0, 300);
    const cachedIds = ids.slice(300);
    const cache = loadCache(out);
    for (const id of missingIds) delete cache.vulns[id]; // no record, and the request keeps failing
    for (const id of cachedIds) cache.vulns[id].at -= 8 * 24 * 36e5; // cached but expired (7 d lifetime)
    saveCache(out, cache);
    for (const id of missingIds) fake.state.failIds.add(id);

    fake.state.seen.length = 0;
    await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.state.seen.length, 300);
    assert.equal(new Set(fake.state.seen).size, 300, 'no duplicate requests in a run');

    fake.state.seen.length = 0;
    const r2 = await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.state.seen.length, 300);
    assert.equal(new Set(fake.state.seen).size, 300, 'no duplicate requests in a run');
    assert.deepEqual(new Set(fake.state.seen.slice(0, 20)), new Set(cachedIds), 'cached ids get their turn ahead of the ids that just failed');
    assert.equal(r2.pendingDetails + r2.failedDetails, 0, 'every cached record refreshed');
    const skipped = missingIds.filter((id) => !fake.state.seen.includes(id));
    assert.equal(skipped.length, 20);

    fake.state.seen.length = 0;
    await advisoriesFor({ out, targets, online: true });
    assert.deepEqual(new Set(fake.state.seen.slice(0, 20)), new Set(skipped), 'ids the last run did not reach go first');
    assert.equal(new Set(fake.state.seen).size, fake.state.seen.length);
  } finally { await fake.close(); rm(root); }
});

const npmTargets = (n) => Array.from({ length: n }, (_, i) => ({ name: `pkg${String(i).padStart(4, '0')}`, version: '1.0.0' }));
const npmUrls = (list) => list.map((t) => `/${t.name}/1.0.0`);

test('registry: more than 300 targets are finished across runs and reported as deferred', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = npmTargets(305);
    const first = await registryFor({ out, targets, online: true });
    assert.equal(fake.state.npmSeen.length, 300, 'at most 300 registry requests per run');
    assert.equal(first.deferred, 5);
    assert.equal(first.byKey.size, 300);
    fake.state.npmSeen.length = 0;
    const second = await registryFor({ out, targets, online: true });
    assert.deepEqual(fake.state.npmSeen, npmUrls(targets.slice(300)), 'only the five unattempted targets are requested');
    assert.equal(second.deferred, 0);
    assert.equal(second.byKey.size, 305);
  } finally { await fake.close(); rm(root); }
});

test('registry: a persistently failing target rotates behind later targets, and the failure survives offline runs', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = npmTargets(305);
    fake.state.failNpm.add('pkg0000'); // the first target keeps failing
    const first = await registryFor({ out, targets, online: true });
    assert.equal(first.failed, 1);
    assert.equal(first.deferred, 5);
    assert.match(first.error, /registry pkg0000/);
    fake.state.npmSeen.length = 0;
    const second = await registryFor({ out, targets, online: true });
    assert.equal(fake.state.npmSeen.length, 6, 'the five unattempted targets plus the failing one');
    assert.deepEqual(fake.state.npmSeen.slice(0, 5), npmUrls(targets.slice(300)), 'unattempted targets go before the retry of the failure');
    assert.equal(new Set(fake.state.npmSeen).size, 6, 'no duplicate requests');
    assert.equal(second.byKey.size, 304, 'later targets succeeded although the first keeps failing');
    assert.equal(second.failed, 1);
    assert.equal(second.deferred, 0);
    fake.state.npmSeen.length = 0;
    const offline = await registryFor({ out, targets, online: false });
    assert.equal(fake.state.npmSeen.length, 0, 'offline makes no request');
    assert.equal(offline.failed, 1, 'the failure is still reported offline');
    fake.state.failNpm.clear();
    const third = await registryFor({ out, targets, online: true });
    assert.equal(third.failed, 0);
    assert.equal(third.byKey.size, 305);
  } finally { await fake.close(); rm(root); }
});

test('registry: --refresh persists capped fresh targets, which stay partial offline and retry without --refresh', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = npmTargets(305);
    await registryFor({ out, targets, online: true });
    await registryFor({ out, targets, online: true }); // all 305 cached
    fake.state.npmSeen.length = 0;
    const r1 = await registryFor({ out, targets, online: true, force: true });
    assert.equal(fake.state.npmSeen.length, 300);
    assert.equal(r1.deferred, 5);
    const expectedDeferred = targets.slice(300).map((t) => `${t.name}@${t.version}`);
    assert.deepEqual(Object.keys(loadCache(out).npmDeferred).sort(), expectedDeferred.sort());
    const offline = await registryFor({ out, targets, online: false });
    assert.equal(offline.deferred, 5, 'deferred markers keep offline coverage partial');
    fake.state.npmSeen.length = 0;
    const r2 = await registryFor({ out, targets, online: true });
    assert.deepEqual(fake.state.npmSeen, npmUrls(targets.slice(300)), 'normal online run retries only the five capped targets');
    assert.equal(r2.deferred, 0);
    assert.equal(r2.failed, 0);
    assert.equal(r2.byKey.size, 305);
    assert.deepEqual(loadCache(out).npmDeferred, {});
  } finally { await fake.close(); rm(root); }
});

test('deps list and brief keep a capped registry refresh partial offline, then complete after an ordinary retry', async () => {
  const fake = await fakeOsv({ ids: [] });
  const targets = npmTargets(305);
  const dependencies = Object.fromEntries(targets.map((t) => [t.name, '1.0.0']));
  const packages = { '': { name: 'app', dependencies } };
  for (const t of targets) packages[`node_modules/${t.name}`] = { version: t.version };
  const { root, out } = project({ name: 'app', lockfileVersion: 3, packages });
  try {
    write(root, 'package.json', JSON.stringify({ name: 'app', dependencies }));
    await buildMap({ root, out });
    const store = loadStore(out);
    const config = loadConfig(root);
    const memory = createMemory({ root, dir: path.join(out, 'memory') });
    const refresh = await runDeps({ root, out, store, memory, config, args: { refresh: true }, allowOnline: true });
    assert.match(refresh, /5 deferred by the 300-item per-run cap/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);

    const hits = fake.state.npmSeen.length;
    const offline = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: false });
    assert.equal(fake.state.npmSeen.length, hits, 'offline reads the persisted queue without network access');
    assert.match(offline, /5 deferred by the 300-item per-run cap/);
    assert.equal(loadCache(out).summary.complete, false);
    assert.match(depsSummary(out, store), /partially checked/);

    fake.state.npmSeen.length = 0;
    const recovered = await runDeps({ root, out, store, memory, config, args: {}, allowOnline: true });
    assert.deepEqual(fake.state.npmSeen, npmUrls(targets.slice(300)), 'ordinary online list run only retries the remaining five');
    assert.doesNotMatch(recovered, /deferred by the 300-item per-run cap/);
    assert.equal(loadCache(out).summary.complete, true);
    assert.match(depsSummary(out, store), /checked/);
  } finally { await fake.close(); rm(root); }
});

test('registry: a deferred refresh failure is distinct, preserves cached metadata, and retries on an ordinary online run', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const targets = npmTargets(305);
    const cache = loadCache(out);
    for (const t of targets) cache.npm[`${t.name}@${t.version}`] = { deprecated: null, homepage: null, repo: null, at: Date.now(), retained: t.name === 'pkg0304' };
    saveCache(out, cache);
    const refresh = await registryFor({ out, targets, online: true, force: true });
    assert.equal(refresh.deferred, 5);
    fake.state.failNpm.add('pkg0304');
    const failed = await registryFor({ out, targets, online: true });
    assert.equal(failed.failed, 1);
    assert.equal(failed.deferred, 0, 'an attempted failure is counted as failed, not deferred');
    assert.equal(failed.byKey.get('pkg0304@1.0.0').retained, true, 'failed request keeps the cached record');
    assert.equal(loadCache(out).npmDeferred['pkg0304@1.0.0'], undefined);
    assert.ok(loadCache(out).npmTried['pkg0304@1.0.0']);
    fake.state.failNpm.clear();
    fake.state.npmSeen.length = 0;
    const recovered = await registryFor({ out, targets, online: true });
    assert.deepEqual(fake.state.npmSeen, ['/pkg0304/1.0.0']);
    assert.equal(recovered.failed, 0);
    assert.equal(recovered.deferred, 0);
    assert.equal(loadCache(out).npmTried['pkg0304@1.0.0'], undefined);
  } finally { await fake.close(); rm(root); }
});

test('registry: over-cap legacy failure is counted only as deferred and succeeds on a fair retry', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  const targets = npmTargets(305);
  const now = 10_000;
  try {
    const cache = loadCache(out);
    for (const t of targets) cache.npm[`${t.name}@${t.version}`] = { deprecated: null, homepage: null, repo: null, at: now };
    cache.npmTried['pkg0304@1.0.0'] = now + 0.5;
    saveCache(out, cache);

    const capped = await registryFor({ out, targets, online: true, force: true, now: now + 1 });
    assert.equal(fake.state.npmSeen.length, 300);
    assert.equal(capped.deferred, 5);
    assert.equal(capped.failed, 0, 'deferred wins over a simultaneous tried marker');
    assert.ok(loadCache(out).npmTried['pkg0304@1.0.0'], 'cap does not erase failure history');
    assert.ok(loadCache(out).npmDeferred['pkg0304@1.0.0']);

    const offline = await registryFor({ out, targets, online: false, now: now + 2 });
    assert.equal(offline.deferred, 5);
    assert.equal(offline.failed, 0, 'persisted offline counts stay disjoint');

    fake.state.npmSeen.length = 0;
    const retried = await registryFor({ out, targets, online: true, now: now + 3 });
    assert.equal(fake.state.npmSeen.length, 5);
    assert.ok(fake.state.npmSeen.includes('/pkg0304/1.0.0'), 'the failed deferred target is retried');
    assert.equal(retried.deferred + retried.failed, 0);
    assert.equal(loadCache(out).npmTried['pkg0304@1.0.0'], undefined);
    assert.equal(loadCache(out).npmDeferred['pkg0304@1.0.0'], undefined);
  } finally { await fake.close(); rm(root); }
});

test('registry: exact-version 404 clears pending markers but remains unknown; legacy version-1 caches load', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    const target = { name: 'gone-pkg', version: '1.0.0' };
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'deps-cache.json'), JSON.stringify({ v: 1, osv: {}, vulns: {}, npm: {}, npmTried: {}, summary: null }));
    const legacy = loadCache(out);
    legacy.npmTried['gone-pkg@1.0.0'] = Date.now();
    legacy.npmDeferred = { 'gone-pkg@1.0.0': Date.now() };
    saveCache(out, legacy);
    fake.state.notFoundNpm.add(target.name);
    const r = await registryFor({ out, targets: [target], online: true });
    assert.equal(r.notFound, 1);
    assert.equal(r.byKey.get('gone-pkg@1.0.0').notFound, true);
    assert.equal(r.failed, 0);
    assert.equal(r.deferred, 0);
    assert.equal(r.cache.npmTried['gone-pkg@1.0.0'], undefined);
    assert.equal(r.cache.npmDeferred['gone-pkg@1.0.0'], undefined);
  } finally { await fake.close(); rm(root); }
});

test('--refresh refetches fresh details under the 300 cap and continues fairly', async () => {
  const ids = Array.from({ length: 305 }, (_, i) => `GHSA-${String(i).padStart(4, '0')}`);
  const fake = await fakeOsv({ ids });
  const { root, out } = project();
  try {
    const targets = [{ name: 'lodash', version: '4.17.15' }];
    await advisoriesFor({ out, targets, online: true });
    await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.vuln, 305);
    await advisoriesFor({ out, targets, online: true });
    assert.equal(fake.hits.vuln, 305, 'fresh details are reused without refresh');
    fake.state.seen.length = 0;
    const r = await advisoriesFor({ out, targets, online: true, force: true });
    assert.equal(fake.hits.osv, 2, 'the package lookup is repeated under force');
    assert.equal(fake.state.seen.length, 300, 'capped at 300 per run');
    assert.equal(new Set(fake.state.seen).size, 300);
    assert.equal(r.staleDetails, 5, 'the five not yet refreshed are reported stale');
    fake.state.seen.length = 0;
    const r2 = await advisoriesFor({ out, targets, online: true, force: true });
    assert.equal(fake.state.seen.length, 300);
    assert.equal(r2.staleDetails, 5);
    assert.equal(fake.state.seen.slice(0, 5).sort().join(), ids.slice(300).concat().sort().join(), 'the five left over go first on the next forced run');
  } finally { await fake.close(); rm(root); }
});

test('an empty-query offline docs lookup prefers the fresh current-version note over a stale pinned one, with no request', async () => {
  const fake = await fakeOsv({ ids: [] });
  const { root, out } = project();
  try {
    await buildMap({ root, out });
    const memory = createMemory({ root, dir: path.join(out, 'memory'), versionOf: versionOfFrom(() => loadStore(out)) });
    memory.remember({ title: 'docs: lodash@4.17.10', body: 'Old overview.', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.10' }] });
    memory.remember({ title: 'docs: lodash@4.17.15', body: 'Current overview.', tags: ['docs', 'lodash'], pins: [{ pkg: 'lodash', version: '4.17.15' }] });
    const note = await docsFor({ out, memory, name: 'lodash', version: '4.17.15', policy: { allowed: false, why: 'Network lookups are off.' } });
    assert.match(note, /docs: lodash@4\.17\.15/);
    assert.match(note, /Current overview/);
    assert.doesNotMatch(note, /Old overview/);
    assert.match(note, /fresh/);
    assert.match(note, /no network used/);
    assert.deepEqual(fake.hits, { osv: 0, npm: 0, vuln: 0 }, 'zero requests');
  } finally { await fake.close(); rm(root); }
});
