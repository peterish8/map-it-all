import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/pr/normalize.mjs';
import { createProvider } from '../src/pr/provider.mjs';
import { parseTarget } from '../src/pr/target.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'pr', 'stale-sha');
const TARGET = parseTarget('https://github.com/fixture-org/fixture-repo/pull/42');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const MISSING_GH = path.join(ROOT, 'test', 'fixtures', 'pr', 'no-such-dir', 'gh');
const OBSERVED = '2026-11-16T04:31:00Z';

// Read a replay scenario the way the status command will: pull request, commits, policy, then checks,
// statuses and Actions jobs for every commit and job the answers name.
function collect(scenario) {
  const env = { MAP_IT_ALL_GH_REPLAY: path.join(FIXTURES, `${scenario}.json`), MAP_IT_ALL_GH_BIN: MISSING_GH };
  const p = createProvider({ target: TARGET, env });
  const pullRequest = p.read('pullRequest').body;
  const commits = p.read('pullRequestCommits').body;
  const rules = p.read('branchRules:main');
  const branch = p.read('branch:main');
  const checkRuns = {};
  const commitStatuses = {};
  const jobs = {};
  for (const sha of (commits ?? []).map((c) => c.sha)) {
    checkRuns[sha] = p.read(`checkRuns:${sha}`).body;
    commitStatuses[sha] = p.read(`commitStatuses:${sha}`).body;
    for (const run of checkRuns[sha]?.check_runs ?? []) {
      const jobId = String(run.details_url ?? '').match(/\/job\/(\d+)$/)?.[1];
      if (jobId) jobs[jobId] = p.read(`actionsJob:${jobId}`).body;
    }
  }
  return { pullRequest, commits, rules, branch, checkRuns, commitStatuses, jobs };
}

const normalized = (scenario) => normalize({ target: TARGET, observedAt: OBSERVED, ...collect(scenario) });

test('the pull request is pinned from the GraphQL answer, with head, base and commit time', () => {
  const { pr } = normalized('S2-late-green-old-head');
  assert.equal(pr.repositoryId, 'R_fx_0001');
  assert.equal(pr.repository, 'fixture-org/fixture-repo');
  assert.equal(pr.number, 42);
  assert.equal(pr.state, 'open');
  assert.equal(pr.isDraft, false);
  assert.equal(pr.headSha, B);
  assert.equal(pr.baseRef, 'main');
  assert.equal(pr.baseSha, '1'.repeat(40));
  assert.equal(pr.headCommittedAt, '2026-11-16T04:19:30Z', 'the commit time of the head');
  assert.equal(pr.mergeStateStatus, 'BLOCKED');
  assert.equal(pr.reviewDecision, null);
});

test('S2 check runs are observations for head A with run, attempt and job, and none for head B', () => {
  const { observations } = normalized('S2-late-green-old-head');
  const runs = observations.filter((o) => o.kind === 'check_run');
  const byRun = (id) => runs.find((o) => o.checkRunId === id);
  assert.deepEqual(runs.map((o) => o.checkRunId), [9101, 9103, 9102], 'sorted by SHA, name, then ID');
  assert.ok(runs.every((o) => o.checkedSha === A), 'the SHA comes from the answer that named the commit');
  assert.deepEqual([9101, 9102, 9103].map((id) => byRun(id).attempt), [1, 1, 2], 'the attempt comes from the job answer');
  assert.deepEqual([9101, 9102, 9103].map((id) => byRun(id).runId), [61, 61, 61]);
  assert.deepEqual([9101, 9102, 9103].map((id) => byRun(id).jobId), [91, 92, 93]);
  assert.ok(runs.every((o) => o.appId === 15368 && o.source === 'github:check-runs' && o.observedAt === OBSERVED));
  assert.equal(byRun(9103).completedAt, '2026-11-16T04:30:00Z');
  assert.equal(observations.filter((o) => o.checkedSha === B).length, 0);
});

test('S3a keeps the current failure with its run, attempt and job', () => {
  const failed = normalized('S3a-head-b-ubuntu-fails').observations.find((o) => o.checkRunId === 9201);
  assert.equal(failed.checkedSha, B);
  assert.equal(failed.conclusion, 'failure');
  assert.deepEqual([failed.runId, failed.attempt, failed.jobId], [70, 1, 101]);
});

test('LEGACY keeps the commit status creator and the check run from a different app as separate identities', () => {
  const { observations } = normalized('LEGACY');
  const status = observations.find((o) => o.kind === 'status' && o.checkedSha === B);
  assert.equal(status.name, 'ci/legacy');
  assert.equal(status.creator, 'legacy-ci-bot');
  assert.equal(status.appId, null);
  assert.equal(status.statusId, 7301);
  assert.equal(status.conclusion, 'success');
  const wrongApp = observations.find((o) => o.checkRunId === 9301);
  assert.equal(wrongApp.appId, 99999);
});

test('a duplicated check run and a reversed list give the same observations (02-FIXTURES §9)', () => {
  const original = collect('S2-late-green-old-head');
  const reordered = structuredClone(original);
  const runs = reordered.checkRuns[A].check_runs;
  reordered.checkRuns[A] = { total_count: runs.length + 1, check_runs: [...runs].reverse().concat([runs[2]]) };
  assert.deepEqual(normalize({ target: TARGET, observedAt: OBSERVED, ...reordered }), normalize({ target: TARGET, observedAt: OBSERVED, ...original }));
});

test('an unrecognised status or conclusion is unknown, never a success', () => {
  const bodies = collect('S0-head-a-green');
  const [first, second] = bodies.checkRuns[A].check_runs;
  bodies.checkRuns[A] = { total_count: 2, check_runs: [{ ...first, conclusion: 'mystery' }, { ...second, status: 'exploding', conclusion: null }] };
  const [mystery, exploding] = normalize({ target: TARGET, observedAt: OBSERVED, ...bodies }).observations;
  assert.equal(mystery.conclusion, 'unknown');
  assert.equal(exploding.status, 'unknown');
  assert.equal(exploding.conclusion, null);
});

test('run and job IDs come from an Actions URL on this repository only', () => {
  const bodies = collect('S0-head-a-green');
  const [first, second] = bodies.checkRuns[A].check_runs;
  bodies.checkRuns[A] = {
    total_count: 2,
    check_runs: [
      { ...first, details_url: 'https://github.com/other-org/other-repo/actions/runs/61/job/91' },
      { ...second, details_url: 'https://evil.example/fixture-org/fixture-repo/actions/runs/61/job/92' },
    ],
  };
  const [a, b] = normalize({ target: TARGET, observedAt: OBSERVED, ...bodies }).observations;
  assert.deepEqual([a.runId, a.jobId], [null, null]);
  assert.deepEqual([b.runId, b.jobId], [null, null]);
});

test('an attempt is null when the job answer is missing or belongs to another SHA', () => {
  const bodies = collect('S0-head-a-green');
  bodies.jobs = {};
  const noJob = normalize({ target: TARGET, observedAt: OBSERVED, ...bodies }).observations;
  assert.ok(noJob.every((o) => o.attempt === null), 'no job answer, no attempt');
  bodies.jobs = { 91: { id: 91, run_id: 61, run_attempt: 3, head_sha: B } };
  const wrongSha = normalize({ target: TARGET, observedAt: OBSERVED, ...bodies }).observations;
  assert.equal(wrongSha.find((o) => o.jobId === 91).attempt, null, 'a job for another SHA is not used');
});

test('a check run without a valid head SHA is dropped with a note, never attributed to a head', () => {
  const bodies = collect('S0-head-a-green');
  const [first, second] = bodies.checkRuns[A].check_runs;
  bodies.checkRuns[A] = { total_count: 2, check_runs: [{ ...first, head_sha: 'not-a-sha' }, second] };
  const result = normalize({ target: TARGET, observedAt: OBSERVED, ...bodies });
  assert.deepEqual(result.observations.map((o) => o.checkRunId), [9102]);
  assert.match(result.notes.join('\n'), /9101.*no valid head SHA/);
});

test('observations are sorted by a stable key, so the order of the answers never shows', () => {
  const { observations } = normalized('S2-late-green-old-head');
  const keys = observations.map((o) => `${o.checkedSha}|${o.name}|${o.kind}|${o.checkRunId ?? o.statusId}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(observations.map((o) => o.id)).size, observations.length, 'one observation per provider ID');
});

test('every scenario normalises without throwing and every observation has a SHA, a source and a time', () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const { observations } = normalized(name.replace(/\.json$/, ''));
    for (const o of observations) {
      assert.match(o.checkedSha, /^[0-9a-f]{40}$/, name);
      assert.ok(o.source, name);
      assert.equal(o.observedAt, OBSERVED, name);
    }
  }
});
