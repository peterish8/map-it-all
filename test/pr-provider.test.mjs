import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../src/pr/provider.mjs';
import { ReplayExhausted } from '../src/pr/replay.mjs';
import { parseTarget, PrUsageError } from '../src/pr/target.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'pr', 'stale-sha');
const TARGET = parseTarget('https://github.com/fixture-org/fixture-repo/pull/42');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const MISSING_GH = path.join(ROOT, 'test', 'fixtures', 'pr', 'no-such-dir', 'gh');
const SCENARIOS = [
  'APPROVAL.json', 'CONFLICT.json', 'INCOMPLETE.json', 'LEGACY.json', 'S0-head-a-green.json',
  'S1-head-b-missing.json', 'S2-late-green-old-head.json', 'S3a-head-b-ubuntu-fails.json', 'S3b-head-b-green.json',
];

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-provider-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  return { dir, cleanup };
}

function replayFile(dir, name, doc) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

const replayDoc = (operations, extra = {}) => ({
  schemaVersion: 1,
  kind: 'pratzystack.github-replay',
  scenario: 'test-scenario',
  now: '2026-11-16T04:31:00Z',
  target: { owner: 'fixture-org', repo: 'fixture-repo', number: 42 },
  operations,
  ...extra,
});

const replayEnv = (file) => ({ MAP_IT_ALL_GH_REPLAY: file, MAP_IT_ALL_GH_BIN: MISSING_GH });

test('the nine stale-SHA fixtures load and answer the reads the status command needs', () => {
  const found = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(found, SCENARIOS, 'exactly the nine scenario files, no extras');
  for (const name of SCENARIOS) {
    const provider = createProvider({ target: TARGET, env: replayEnv(path.join(FIXTURES, name)) });
    assert.equal(provider.name, 'replay', name);
    const pr = provider.read('pullRequest');
    assert.equal(pr.status, 200, `${name}: pullRequest answers 200`);
    assert.equal(pr.gap, null, `${name}: no gap on pullRequest`);
    assert.equal(pr.body.data.repository.pullRequest.number, 42, name);
    assert.equal(provider.read('pullRequestCommits').status, 200, `${name}: commits answer 200`);
    assert.equal(typeof provider.read('branchRules:main').status, 'number', `${name}: policy read answers`);
  }
});

test('an operation the fixture does not list is a capability gap, never an empty success', () => {
  const provider = createProvider({ target: TARGET, env: replayEnv(path.join(FIXTURES, 'S0-head-a-green.json')) });
  const r = provider.read(`actionsJob:999`);
  assert.equal(r.status, 404);
  assert.equal(r.body, null);
  assert.equal(r.gap, 'not_recorded');
  assert.match(r.message, /actionsJob:999 is not in the replay fixture/);
  assert.equal(provider.read(`checkRuns:${B}`).gap, 'not_recorded', 'the head of a later scenario is not in S0');
});

test('explicit errors and status-only entries become gaps by status', () => {
  const provider = createProvider({ target: TARGET, env: replayEnv(path.join(FIXTURES, 'INCOMPLETE.json')) });
  const denied = provider.read('branchRules:main');
  assert.equal(denied.status, 403);
  assert.equal(denied.gap, 'forbidden');
  const { dir, cleanup } = scratch();
  try {
    const file = replayFile(dir, 'status-only.json', replayDoc({
      pullRequest: { status: 410 },
      'branch:main': { status: 401 },
      [`checkRuns:${A}`]: { status: 502 },
    }));
    const p = createProvider({ target: TARGET, env: replayEnv(file) });
    assert.deepEqual([p.read('pullRequest').gap, p.read('branch:main').gap, p.read(`checkRuns:${A}`).gap],
      ['not_found_or_no_access', 'auth', 'provider_error']);
    assert.equal(p.read('pullRequest').body, null, 'a status-only entry has no body');
  } finally { cleanup(); }
});

test('GraphQL errors: partial when data is present, not found for a missing pull request, else a provider error', () => {
  const { dir, cleanup } = scratch();
  try {
    const file = replayFile(dir, 'partial.json', replayDoc({
      pullRequest: { status: 200, body: { data: { repository: { id: 'R_fx_0001', pullRequest: { number: 42 } } }, errors: [{ message: 'Resource not accessible' }] } },
      'branch:main': { status: 200, body: { data: { repository: null }, errors: [{ message: 'Could not resolve' }] } },
      [`commitStatuses:${B}`]: { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ message: 'Could not resolve to a PullRequest' }] } },
    }));
    const p = createProvider({ target: TARGET, env: replayEnv(file) });
    const pr = p.read('pullRequest');
    assert.equal(pr.gap, 'partial');
    assert.match(pr.message, /Resource not accessible/);
    assert.equal(pr.body.data.repository.pullRequest.number, 42, 'the partial data is kept for the caller to judge');
    assert.equal(p.read('branch:main').gap, 'provider_error');
    assert.equal(p.read(`commitStatuses:${B}`).gap, 'not_found_or_no_access', 'a pullRequest lookup that returns null is a not-found, whatever the operation name');
  } finally { cleanup(); }
});

test('ordered responses are consumed in order and the last one repeats', () => {
  const { dir, cleanup } = scratch();
  try {
    const file = replayFile(dir, 'ordered.json', replayDoc({
      pullRequest: [
        { status: 200, body: { data: { repository: { pullRequest: { headRefOid: B } } } } },
        { status: 200, body: { data: { repository: { pullRequest: { headRefOid: A } } } } },
      ],
    }));
    const p = createProvider({ target: TARGET, env: replayEnv(file) });
    const heads = [1, 2, 3].map(() => p.read('pullRequest').body.data.repository.pullRequest.headRefOid);
    assert.deepEqual(heads, [B, A, A]);
  } finally { cleanup(); }
});

test('beginReconcile advances a timeline one step and throws ReplayExhausted after its last step', () => {
  const { dir, cleanup } = scratch();
  try {
    const head = (sha) => ({ status: 200, body: { data: { repository: { pullRequest: { headRefOid: sha } } } } });
    const file = replayFile(dir, 'timeline.json', replayDoc(undefined, {
      timeline: [{ operations: { pullRequest: head(B) } }, { operations: { pullRequest: head(A) } }],
    }));
    const p = createProvider({ target: TARGET, env: replayEnv(file) });
    assert.equal(p.read('pullRequest').body.data.repository.pullRequest.headRefOid, B);
    p.beginReconcile();
    assert.equal(p.read('pullRequest').body.data.repository.pullRequest.headRefOid, A);
    assert.throws(() => p.beginReconcile(), ReplayExhausted);
  } finally { cleanup(); }
});

test('a single-state replay treats beginReconcile as a re-read of the same recorded answers', () => {
  const p = createProvider({ target: TARGET, env: replayEnv(path.join(FIXTURES, 'S1-head-b-missing.json')) });
  const before = p.read('pullRequest').body;
  p.beginReconcile();
  assert.deepEqual(p.read('pullRequest').body, before);
});

test('replay mode never starts gh, even when a recording gh is configured', () => {
  const { dir, cleanup } = scratch();
  try {
    const marker = path.join(dir, 'gh-ran.txt');
    const fakeGh = path.join(dir, 'fake-gh.mjs');
    writeFileSync(fakeGh, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const env = { MAP_IT_ALL_GH_REPLAY: path.join(FIXTURES, 'S2-late-green-old-head.json'), MAP_IT_ALL_GH_BIN: fakeGh };
    const p = createProvider({ target: TARGET, env });
    for (const op of ['pullRequest', 'pullRequestCommits', 'branchRules:main', 'branch:main', `checkRuns:${B}`, `commitStatuses:${B}`]) p.read(op);
    p.read('actionsJob:999');
    assert.equal(existsSync(marker), false, 'the recording gh was never executed');
    assert.equal(p.read('pullRequest').status, 200, 'and the answers still come from the fixture');
  } finally { cleanup(); }
});

test('a replay for another pull request is refused with a usage error', () => {
  const other = parseTarget('https://github.com/fixture-org/fixture-repo/pull/7');
  assert.throws(() => createProvider({ target: other, env: replayEnv(path.join(FIXTURES, 'S0-head-a-green.json')) }), (error) => {
    assert.ok(error instanceof PrUsageError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /fixture-org\/fixture-repo#42, not fixture-org\/fixture-repo#7/);
    return true;
  });
});

test('a file that is not a replay fixture is refused with a usage error', () => {
  const { dir, cleanup } = scratch();
  try {
    const wrongKind = replayFile(dir, 'wrong-kind.json', replayDoc({}, { kind: 'something.else' }));
    const noTime = replayFile(dir, 'no-now.json', replayDoc({}, { now: 'yesterday' }));
    const notJson = path.join(dir, 'not-json.json');
    writeFileSync(notJson, '{ nope');
    for (const file of [wrongKind, noTime, notJson, path.join(dir, 'missing.json')]) {
      assert.throws(() => createProvider({ target: TARGET, env: replayEnv(file) }), (e) => e instanceof PrUsageError && e.exitCode === 2, file);
    }
  } finally { cleanup(); }
});

test('fixtures contain only synthetic identifiers and no credentials', () => {
  for (const name of SCENARIOS) {
    const text = readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_/, `${name}: no token-shaped value`);
    assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]{2,}/i, `${name}: no e-mail address`);
    for (const [url] of text.matchAll(/https:\/\/github\.com\/[^"\s]*/g)) {
      assert.ok(url.startsWith('https://github.com/fixture-org/fixture-repo/'), `${name}: ${url} is a fixture URL`);
    }
  }
});

test('the PR path never imports the network module (defect d)', () => {
  const dir = path.join(ROOT, 'src', 'pr');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.includes('provider.mjs'), 'the PR path exists');
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /net\.mjs|fetchText|networkPolicy/, `${f} must not use src/net.mjs`);
  }
});
