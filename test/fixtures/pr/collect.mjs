// Test helper (not product code): read one replay scenario the way `pr status` reads a pull request (pull
// request, commits, policy, checks, statuses and Actions jobs), then normalise it and derive the policy.
// The status command has the production version; this helper lets the evaluator tests start from real bodies.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../../src/pr/normalize.mjs';
import { derivePolicy } from '../../../src/pr/policy.mjs';
import { createProvider } from '../../../src/pr/provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = path.join(HERE, 'stale-sha');
export const MISSING_GH = path.join(HERE, 'no-such-dir', 'gh');

export function collectScenario(name, target, extraEnv = {}) {
  const env = { MAP_IT_ALL_GH_REPLAY: path.join(SCENARIO_DIR, `${name}.json`), MAP_IT_ALL_GH_BIN: MISSING_GH, ...extraEnv };
  const p = createProvider({ target, env });
  const reads = {};
  const read = (op) => {
    reads[op] = p.read(op);
    return reads[op];
  };
  const pullRequest = read('pullRequest');
  const commits = read('pullRequestCommits');
  const baseRef = normalize({ target, observedAt: p.now, pullRequest: pullRequest.body }).pr?.baseRef ?? 'main';
  const rules = read(`branchRules:${baseRef}`);
  const branch = read(`branch:${baseRef}`);
  const checkRuns = {};
  const commitStatuses = {};
  const jobs = {};
  for (const sha of (commits.body ?? []).map((c) => c.sha)) {
    checkRuns[sha] = read(`checkRuns:${sha}`).body;
    commitStatuses[sha] = read(`commitStatuses:${sha}`).body;
    for (const run of checkRuns[sha]?.check_runs ?? []) {
      const jobId = String(run.details_url ?? '').match(/\/job\/(\d+)$/)?.[1];
      if (jobId) jobs[jobId] = read(`actionsJob:${jobId}`).body;
    }
  }
  const normalized = normalize({ target, observedAt: p.now, pullRequest: pullRequest.body, commits: commits.body, rules, branch, checkRuns, commitStatuses, jobs });
  const gaps = Object.entries(reads)
    .filter(([op, r]) => r.gap && !op.startsWith('actionsJob:'))
    .map(([operation, r]) => ({ operation, gap: r.gap, status: r.status, message: r.message }));
  return {
    now: p.now,
    reads,
    normalized,
    policy: derivePolicy(normalized.policyInputs),
    gaps,
    observation: gaps.length ? 'partial' : 'complete',
  };
}
