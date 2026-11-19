// Read-only GitHub transport. Every PR read is one `gh api` call with an argv array: never a shell string,
// never a write verb, never a token on the command line (gh holds the login). Lists are paged with
// --paginate and the pages are merged here, so the normaliser sees the same bodies as the replay transport.
//
// MAP_IT_ALL_GH_BIN may name the gh binary. A path ending in .js/.mjs/.cjs runs under this Node; that is how the
// tests drive test/fixtures/pr/fake-gh.mjs.

import { spawnSync } from 'node:child_process';
import { finalize, GAP, read } from './contract.mjs';

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const ACCEPT = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
const MISSING_GH = 'GitHub CLI (gh) was not found. Install it from https://cli.github.com, run `gh auth login`, or set MAP_IT_ALL_GH_BIN.';
const SHA = /^[0-9a-f]{40}$/;
const JOB = /^[1-9][0-9]{0,15}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

// Read-only GraphQL query: one pull request with the fields the policy and the pin need.
const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    pullRequest(number: $number) {
      id number url state isDraft mergedAt
      baseRefName baseRefOid headRefName headRefOid
      headRepository { id nameWithOwner }
      mergeable mergeStateStatus reviewDecision
      mergeQueueEntry { id }
      autoMergeRequest { enabledAt }
      reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
      commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
    }
  }
}`;

const branchPath = (base) => (BRANCH.test(base) && !base.includes('..') ? base.split('/').map(encodeURIComponent).join('/') : null);

/** The gh argv for one logical operation, or null when the operation or its input is not acceptable. */
export function argsFor(op, target) {
  const { owner, repo, number } = target;
  const root = `repos/${owner}/${repo}`;
  const rest = (...extra) => ['api', '--method', 'GET', ...ACCEPT, ...extra];
  const paged = (jq, endpoint) => ['api', '--method', 'GET', '--paginate', ...ACCEPT, '--jq', jq, endpoint];
  if (op === 'pullRequest') {
    return ['api', 'graphql', '-f', `query=${PULL_REQUEST_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${repo}`, '-F', `number=${number}`];
  }
  if (op === 'pullRequestCommits') return paged('.[] | tojson', `${root}/pulls/${number}/commits?per_page=100`);
  const [kind, value] = [op.slice(0, op.indexOf(':')), op.slice(op.indexOf(':') + 1)];
  if (kind === 'branchRules') {
    const p = branchPath(value);
    return p ? paged('.[] | tojson', `${root}/rules/branches/${p}?per_page=100`) : null;
  }
  if (kind === 'branch') {
    const p = branchPath(value);
    return p ? rest(`${root}/branches/${p}`) : null;
  }
  if (kind === 'checkRuns') return SHA.test(value) ? paged('.check_runs[] | tojson', `${root}/commits/${value}/check-runs?per_page=100`) : null;
  if (kind === 'commitStatuses') return SHA.test(value) ? paged('.statuses[] | tojson', `${root}/commits/${value}/status?per_page=100`) : null;
  if (kind === 'actionsJob') return JOB.test(value) ? rest(`${root}/actions/jobs/${value}`) : null;
  return null;
}

function run(bin, args, env) {
  const script = /\.(m|c)?js$/i.test(bin);
  return spawnSync(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const failure = (op, gap, status, message) => read(status, null, { gap, message: `${op}: ${message}` });

// Turn one gh result into a read. A non-zero exit is still read when it is a GraphQL answer on stdout.
function interpret(op, shape, r) {
  if (r.error) {
    const message = r.error.code === 'ENOENT' ? MISSING_GH
      : r.signal || r.error.code === 'ETIMEDOUT' ? `gh did not answer within ${TIMEOUT_MS / 1000} s`
        : 'gh could not be started';
    return failure(op, GAP.UNAVAILABLE, 0, message);
  }
  const stdout = r.stdout ?? '';
  const stderr = (r.stderr ?? '').trim();
  if (r.status !== 0) {
    const graphql = shape === 'graphql' ? (() => { try { return JSON.parse(stdout); } catch { return null; } })() : null;
    if (graphql && (graphql.data || graphql.errors)) return finalize(op, { status: 200, body: graphql });
    const first = stderr.split('\n')[0] ?? '';
    const http = /HTTP (\d{3})/.exec(stderr);
    if (/rate limit/i.test(stderr)) return failure(op, GAP.RATE_LIMITED, http ? Number(http[1]) : 403, first);
    if (http) return finalize(op, { status: Number(http[1]), body: null, message: first });
    if (/gh auth login|not logged in|authentication required/i.test(stderr)) return failure(op, GAP.AUTH, 401, 'gh is not signed in: run `gh auth login`');
    return failure(op, GAP.PROVIDER, 0, first.slice(0, 200) || `gh exited with ${r.status}`);
  }
  try {
    if (shape === 'graphql' || shape === 'object') return finalize(op, { status: 200, body: JSON.parse(stdout) });
    if (shape === 'list') return finalize(op, { status: 200, body: lines(stdout) });
    if (shape === 'check_runs') {
      const runs = lines(stdout);
      return finalize(op, { status: 200, body: { total_count: runs.length, check_runs: runs } });
    }
    if (shape === 'statuses') return finalize(op, { status: 200, body: { state: null, statuses: lines(stdout) } });
  } catch {
    return failure(op, GAP.INVALID, 200, 'gh returned output that is not JSON');
  }
  return failure(op, GAP.INVALID, 200, 'unknown response shape');
}

const SHAPE = (op) => {
  if (op === 'pullRequest') return 'graphql';
  if (op === 'pullRequestCommits' || op.startsWith('branchRules:')) return 'list';
  if (op.startsWith('checkRuns:')) return 'check_runs';
  if (op.startsWith('commitStatuses:')) return 'statuses';
  return 'object';
};

export function createGitHubProvider({ target, env = process.env }) {
  const bin = env.MAP_IT_ALL_GH_BIN || 'gh';
  return {
    name: 'gh',
    read(op) {
      const args = argsFor(op, target);
      if (!args) return read(0, null, { gap: GAP.INVALID, message: `${op} is not a PR read this tool makes` });
      return interpret(op, SHAPE(op), run(bin, args, env));
    },
    /** Live reads have no recorded step: a reconcile simply reads again. */
    beginReconcile() {},
  };
}
