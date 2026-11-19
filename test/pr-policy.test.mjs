import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectScenario } from './fixtures/pr/collect.mjs';
import { evaluate } from '../src/pr/policy.mjs';
import { parseTarget } from '../src/pr/target.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = parseTarget('https://github.com/fixture-org/fixture-repo/pull/42');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = '1'.repeat(40);
const NOW = '2026-11-16T04:40:00Z';

const verdict = (name) => {
  const c = collectScenario(name, TARGET);
  return evaluate({ pr: c.normalized.pr, policy: c.policy, observations: c.normalized.observations, now: c.now, observation: c.observation, gaps: c.gaps });
};

// 02-FIXTURES section 5, row by row. Blockers are [code, context] pairs.
const ROWS = {
  'S0-head-a-green': { ready: true, state: 'ready', dims: ['complete', 'open', 'green', 'not_required', 'mergeable'], blockers: [] },
  'S1-head-b-missing': { ready: false, state: 'observing', dims: ['complete', 'open', 'pending', 'not_required', 'blocked'], blockers: [['required_check_missing', 'test (ubuntu-latest)'], ['required_check_missing', 'test (windows-latest)']] },
  'S2-late-green-old-head': { ready: false, state: 'observing', dims: ['complete', 'open', 'pending', 'not_required', 'blocked'], blockers: [['required_check_missing', 'test (ubuntu-latest)'], ['required_check_missing', 'test (windows-latest)']] },
  'S3a-head-b-ubuntu-fails': { ready: false, state: 'needs_action', dims: ['complete', 'open', 'failing', 'not_required', 'blocked'], blockers: [['required_check_failed', 'test (ubuntu-latest)']] },
  'S3b-head-b-green': { ready: true, state: 'ready', dims: ['complete', 'open', 'green', 'not_required', 'mergeable'], blockers: [] },
  APPROVAL: { ready: false, state: 'needs_human', dims: ['complete', 'open', 'green', 'waiting', 'blocked'], blockers: [['review_required', undefined]] },
  INCOMPLETE: { ready: false, state: 'interrupted', dims: ['partial', 'open', 'unknown', 'unknown', 'blocked'], blockers: [['policy_unreadable', undefined]] },
  LEGACY: { ready: false, state: 'observing', dims: ['complete', 'open', 'pending', 'not_required', 'blocked'], blockers: [['required_check_wrong_source', 'test (ubuntu-latest)']] },
  CONFLICT: { ready: false, state: 'needs_action', dims: ['complete', 'open', 'green', 'not_required', 'conflicting'], blockers: [['merge_conflict', undefined]] },
};

const dimsOf = (v) => [v.dimensions.observation, v.dimensions.pr, v.dimensions.requiredCi, v.dimensions.reviews, v.dimensions.merge];

for (const [name, row] of Object.entries(ROWS)) {
  test(`${name}: ready ${row.ready}, state ${row.state}, dimensions and blockers as 02-FIXTURES section 5`, () => {
    const v = verdict(name);
    assert.equal(v.ready, row.ready, `${name} ready`);
    assert.equal(v.state, row.state, `${name} state`);
    assert.deepEqual(dimsOf(v), row.dims, `${name} dimensions [observation, pr, requiredCi, reviews, merge]`);
    assert.deepEqual(v.blockers.map((b) => [b.code, b.context]), row.blockers.map(([code, context]) => [code, context]), `${name} blockers`);
  });
}

test('S2 deep-equals S1 on ready, state, dimensions and blockers; only history differs (the stale-SHA invariant)', () => {
  const s1 = verdict('S1-head-b-missing');
  const s2 = verdict('S2-late-green-old-head');
  assert.deepEqual(
    { ready: s2.ready, state: s2.state, dimensions: s2.dimensions, blockers: s2.blockers },
    { ready: s1.ready, state: s1.state, dimensions: s1.dimensions, blockers: s1.blockers },
  );
  assert.equal(s2.checks.current.length, 0, 'nothing on head B satisfies a gate');
  assert.equal(s2.checks.historical.length, 3, 'all three results for head A are historical');
  assert.ok(s2.checks.historical.every((h) => h.appliesTo === 'none' && h.reason === 'checked_sha_not_current_head'));
  const late = s2.checks.historical.filter((h) => h.arrivedAfterHeadChange);
  assert.deepEqual(late.map((h) => h.checkRunId), [9103], 'the re-run that completed after B became head');
});

test('S3a: the current failure is the one that counts, with its run, attempt and job; A stays historical', () => {
  const v = verdict('S3a-head-b-ubuntu-fails');
  const [blocker] = v.blockers;
  assert.equal(blocker.checkRunId, 9201);
  assert.equal(blocker.headSha, B);
  assert.deepEqual([blocker.runId, blocker.attempt, blocker.jobId], [70, 1, 101]);
  assert.equal(blocker.expectedAppId, 15368);
  assert.ok(v.checks.current.some((c) => c.checkRunId === 9201 && c.checkedSha === B));
  assert.equal(v.checks.historical.length, 3);
});

test('APPROVAL: green CI with a required human approval reports review_required and nothing else', () => {
  const v = verdict('APPROVAL');
  assert.equal(v.dimensions.requiredCi, 'green');
  assert.equal(v.dimensions.reviews, 'waiting');
  assert.deepEqual(v.blockers.map((b) => [b.code, b.kind]), [['review_required', 'human']]);
});

test('INCOMPLETE: a policy read that fails makes required CI unknown, even with green observed checks', () => {
  const v = verdict('INCOMPLETE');
  assert.equal(v.dimensions.requiredCi, 'unknown');
  const [b] = v.blockers;
  assert.equal(b.operation, 'branchRules:main');
  assert.equal(b.status, 403);
  assert.equal(b.kind, 'unknown');
});

test('LEGACY: the any-source context is satisfied by a status; the pinned context does not count from the wrong app', () => {
  const v = verdict('LEGACY');
  const [b] = v.blockers;
  assert.equal(b.code, 'required_check_wrong_source');
  assert.equal(b.seenAppId, 99999);
  assert.equal(b.expectedAppId, 15368);
  assert.equal(v.checks.current.find((c) => c.name === 'ci/legacy').kind, 'status');
});

// ---- synthetic inputs: the evaluator is pure, so these build the inputs directly ----------------------------

const pr = (over = {}) => ({
  repositoryId: 'R_fx_0001', repository: 'fixture-org/fixture-repo', number: 42, url: 'https://github.com/fixture-org/fixture-repo/pull/42',
  state: 'open', isDraft: false, mergedAt: null, baseRef: 'main', baseSha: BASE, headRef: 'feature/x', headSha: B,
  mergeable: 'mergeable', mergeStateStatus: 'CLEAN', reviewDecision: null, mergeQueued: false, autoMerge: false,
  unresolvedThreads: 0, threadsTruncated: false, headCommittedAt: '2026-11-16T04:19:30Z', ...over,
});
const policy = (over = {}) => ({ coverage: 'complete', sources: ['ruleset:7001'], required: [], requiredApprovals: 0, unreadable: [], ...over });
const run = ({ name = 'ci/a', sha = B, conclusion = 'success', status = 'completed', id = 1, appId = 15368, attempt = 1, completedAt = '2026-11-16T04:25:00Z' } = {}) => ({
  id: `check_run:${id}`, kind: 'check_run', name, checkedSha: sha, status, conclusion, appId, creator: null, checkRunId: id, statusId: null,
  runId: 70, attempt, jobId: 100 + id, startedAt: null, completedAt, observedAt: NOW, source: 'github:check-runs',
});
const req = (context, appId = 15368) => ({ context, appId });
const check = (over) => evaluate({ pr: pr(over.pr), policy: policy(over.policy), observations: over.observations ?? [], now: over.now ?? NOW, observation: 'complete', gaps: [] });

test('skipped and neutral results pass a required context; a required context seen only as skipped is green', () => {
  const v = check({
    policy: { required: [req('ci/a', null), req('ci/b', null)] },
    observations: [run({ name: 'ci/a', conclusion: 'skipped', id: 1 }), run({ name: 'ci/b', conclusion: 'neutral', id: 2 })],
  });
  assert.equal(v.dimensions.requiredCi, 'green');
  assert.equal(v.ready, true);
});

test('a required workflow with no check at all stays pending, never green', () => {
  const v = check({ policy: { required: [req('build')] }, observations: [] });
  assert.equal(v.dimensions.requiredCi, 'pending');
  assert.equal(v.ready, false);
});

test('a failure on the current head is failing even when an old head was green', () => {
  const v = check({
    policy: { required: [req('ci/a', null)] },
    observations: [run({ name: 'ci/a', sha: A, conclusion: 'success', id: 1 }), run({ name: 'ci/a', sha: B, conclusion: 'failure', id: 2 })],
  });
  assert.equal(v.dimensions.requiredCi, 'failing');
  assert.equal(v.blockers[0].code, 'required_check_failed');
  assert.equal(v.checks.historical.length, 1);
});

test('the latest attempt of the same check counts: a green retry on the head satisfies the gate', () => {
  const v = check({
    policy: { required: [req('ci/a', null)] },
    observations: [run({ name: 'ci/a', conclusion: 'failure', id: 1, attempt: 1 }), run({ name: 'ci/a', conclusion: 'success', id: 2, attempt: 2 })],
  });
  assert.equal(v.dimensions.requiredCi, 'green');
});

test('a re-run still in progress on the head is pending, not the old failure', () => {
  const v = check({
    policy: { required: [req('ci/a', null)] },
    observations: [run({ name: 'ci/a', conclusion: 'failure', id: 1, attempt: 1 }), run({ name: 'ci/a', status: 'in_progress', conclusion: null, id: 2, attempt: 2 })],
  });
  assert.equal(v.dimensions.requiredCi, 'pending');
  assert.equal(v.blockers[0].code, 'required_check_running');
});

test('a BLOCKED merge state with nothing to explain it is merge_blocked_unexplained, never ready', () => {
  const v = check({
    pr: { mergeStateStatus: 'BLOCKED' },
    policy: { required: [req('ci/a', null)] },
    observations: [run({ name: 'ci/a', id: 1 })],
  });
  assert.equal(v.dimensions.requiredCi, 'green');
  assert.deepEqual(v.blockers.map((b) => [b.code, b.kind]), [['merge_blocked_unexplained', 'unknown']]);
  assert.equal(v.state, 'needs_human');
  assert.equal(v.ready, false);
});

test('MERGEABLE with BLOCKED, green checks and REVIEW_REQUIRED gives only review_required', () => {
  const v = check({
    pr: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
    policy: { required: [req('ci/a', null)], requiredApprovals: 1 },
    observations: [run({ name: 'ci/a', id: 1 })],
  });
  assert.deepEqual(v.blockers.map((b) => b.code), ['review_required']);
  assert.equal(v.ready, false);
});

test('a conflicting base is never ready, even with green checks and approvals', () => {
  const v = check({
    pr: { mergeable: 'conflicting', mergeStateStatus: 'DIRTY', reviewDecision: 'APPROVED' },
    policy: { required: [req('ci/a', null)], requiredApprovals: 1 },
    observations: [run({ name: 'ci/a', id: 1 })],
  });
  assert.equal(v.dimensions.merge, 'conflicting');
  assert.equal(v.state, 'needs_action');
  assert.equal(v.ready, false);
});

test('a mergeability that is still being computed is never ready', () => {
  const v = check({ pr: { mergeable: 'unknown', mergeStateStatus: 'UNKNOWN' }, policy: { required: [req('ci/a', null)] }, observations: [run({ name: 'ci/a', id: 1 })] });
  assert.equal(v.dimensions.merge, 'computing');
  assert.equal(v.blockers[0].code, 'merge_state_computing');
  assert.equal(v.ready, false);
});

test('a draft PR is never ready and needs the author', () => {
  const v = check({ pr: { isDraft: true, mergeStateStatus: 'DRAFT' }, policy: { required: [req('ci/a', null)] }, observations: [run({ name: 'ci/a', id: 1 })] });
  assert.equal(v.dimensions.pr, 'draft');
  assert.equal(v.state, 'needs_action');
  assert.equal(v.ready, false);
});

test('a confirmed empty policy is no_required_checks: not ready, and never "tests passed"', () => {
  const v = check({ policy: { required: [] }, observations: [run({ name: 'ci/a', id: 1 })] });
  assert.equal(v.dimensions.requiredCi, 'no_required_checks');
  assert.deepEqual(v.blockers.map((b) => [b.code, b.kind]), [['no_required_checks', 'human']]);
  assert.equal(v.ready, false);
});

test('a missing required context past the registration window still pends, with a warning', () => {
  const v = check({ policy: { required: [req('ci/a', null)] }, observations: [], now: '2026-11-16T04:40:00Z' });
  assert.equal(v.dimensions.requiredCi, 'pending');
  assert.equal(v.blockers[0].pastRegistrationWindow, true);
  assert.deepEqual(v.warnings.map((w) => w.code), ['required_check_missing_past_window']);
  const inside = check({ policy: { required: [req('ci/a', null)] }, observations: [], now: '2026-11-16T04:30:00Z' });
  assert.equal(inside.blockers[0].pastRegistrationWindow, false);
  assert.deepEqual(inside.warnings, []);
});

test('an unreadable policy is unknown: required CI and reviews stay unknown, and the verdict is not ready', () => {
  const v = evaluate({
    pr: pr(),
    policy: policy({ coverage: 'unreadable', required: [], requiredApprovals: null, unreadable: [{ operation: 'branchRules:main', gap: 'forbidden', status: 403 }] }),
    observations: [run({ name: 'ci/a', id: 1 })],
    now: NOW,
    observation: 'partial',
    gaps: [{ operation: 'branchRules:main', gap: 'forbidden', status: 403 }],
  });
  assert.equal(v.dimensions.requiredCi, 'unknown');
  assert.equal(v.dimensions.reviews, 'unknown');
  assert.equal(v.ready, false);
});

test('the evaluator is pure: the time comes from the argument and the module does no I/O', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'pr', 'policy.mjs'), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date\(|\bfs\b|child_process|\bfetch\(/, 'no clock or I/O in the evaluator');
  assert.doesNotMatch(source, /^import /m, 'the evaluator imports nothing: no model adapter, no provider');
});
