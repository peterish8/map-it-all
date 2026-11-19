// Provider bodies to the pin, the policy inputs and observations. One normaliser serves the replay and gh
// transports, so replay tests exercise the real parsing. It never infers a SHA from text: a check run or
// status is an observation of a SHA only when the answer says so, and anything malformed is dropped with a
// note. Unknown enum values become 'unknown' and never a success.

const SHA = /^[0-9a-f]{40}$/;
const CHECK_STATUSES = new Set(['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending']);
const CONCLUSIONS = new Set(['success', 'neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const MERGE_STATE_STATUSES = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
const MERGEABLE = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' };
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const PR_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
const ACTIONS_JOB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/;

const validSha = (value) => {
  const sha = typeof value === 'string' ? value.toLowerCase() : null;
  return sha && SHA.test(sha) ? sha : null;
};
const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The pinned pull request from the GraphQL answer, or null when the answer does not hold one. */
export function pullRequestFrom(body) {
  const repository = body?.data?.repository;
  const p = repository?.pullRequest;
  if (!isObject(repository) || !isObject(p)) return null;
  const headSha = validSha(p.headRefOid);
  const baseSha = validSha(p.baseRefOid);
  const commit = p.commits?.nodes?.[0]?.commit;
  const headCommittedAt = validSha(commit?.oid) === headSha ? text(commit?.committedDate) : null;
  const threads = Array.isArray(p.reviewThreads?.nodes) ? p.reviewThreads.nodes : [];
  return {
    repositoryId: text(repository.id),
    repository: text(repository.nameWithOwner),
    number: integer(p.number),
    url: text(p.url),
    state: PR_STATES[p.state] ?? 'unknown',
    isDraft: p.isDraft === true,
    mergedAt: text(p.mergedAt),
    baseRef: text(p.baseRefName),
    baseSha,
    headRef: text(p.headRefName),
    headSha,
    headRepository: text(p.headRepository?.nameWithOwner),
    mergeable: MERGEABLE[p.mergeable] ?? 'unknown',
    mergeStateStatus: MERGE_STATE_STATUSES.has(p.mergeStateStatus) ? p.mergeStateStatus : 'UNKNOWN',
    reviewDecision: p.reviewDecision == null ? null : (REVIEW_DECISIONS.has(p.reviewDecision) ? p.reviewDecision : 'UNKNOWN'),
    mergeQueued: p.mergeQueueEntry != null,
    autoMerge: p.autoMergeRequest != null,
    unresolvedThreads: threads.filter((t) => t?.isResolved === false).length,
    threadsTruncated: p.reviewThreads?.pageInfo?.hasNextPage === true,
    headCommittedAt,
  };
}

/** Run and job IDs from an Actions URL, only when the URL names this repository. */
function actionsIds(url, target) {
  const m = typeof url === 'string' ? url.match(ACTIONS_JOB_URL) : null;
  if (!m || m[1].toLowerCase() !== target.owner.toLowerCase() || m[2].toLowerCase() !== target.repo.toLowerCase()) {
    return { runId: null, jobId: null };
  }
  return { runId: Number(m[3]), jobId: Number(m[4]) };
}

function checkRunObservations({ target, queriedSha, body, jobs, observedAt, notes }) {
  const out = [];
  for (const run of Array.isArray(body?.check_runs) ? body.check_runs : []) {
    const id = integer(run?.id);
    const headSha = validSha(run?.head_sha);
    if (id === null || !headSha) {
      notes.push(`check run ${run?.id ?? '?'}: no valid head SHA or id, dropped`);
      continue;
    }
    if (headSha !== queriedSha) {
      notes.push(`check run ${id} was listed for ${queriedSha.slice(0, 7)} but names ${headSha.slice(0, 7)}, dropped`);
      continue;
    }
    const { runId, jobId } = actionsIds(run.details_url, target);
    const job = jobId === null ? null : jobs[jobId];
    const attempt = isObject(job) && integer(job.id) === jobId && integer(job.run_id) === runId && validSha(job.head_sha) === headSha
      ? integer(job.run_attempt) : null;
    const status = CHECK_STATUSES.has(run.status) ? run.status : 'unknown';
    const conclusion = status === 'completed' ? (CONCLUSIONS.has(run.conclusion) ? run.conclusion : 'unknown') : null;
    out.push({
      id: `check_run:${id}`,
      kind: 'check_run',
      name: text(run.name) ?? '',
      checkedSha: headSha,
      status,
      conclusion,
      appId: integer(run.app?.id),
      creator: null,
      checkRunId: id,
      statusId: null,
      runId,
      attempt,
      jobId,
      startedAt: text(run.started_at),
      completedAt: text(run.completed_at),
      observedAt,
      source: 'github:check-runs',
    });
  }
  return out;
}

function statusObservations({ queriedSha, body, observedAt, notes }) {
  const out = [];
  for (const st of Array.isArray(body?.statuses) ? body.statuses : []) {
    const id = integer(st?.id);
    const name = text(st?.context);
    if (id === null || !name) {
      notes.push(`commit status ${st?.id ?? '?'}: no id or context, dropped`);
      continue;
    }
    const state = st.state;
    const status = state === 'pending' ? 'pending' : (state === 'success' || state === 'failure' || state === 'error' ? 'completed' : 'unknown');
    const conclusion = state === 'success' ? 'success' : (state === 'failure' || state === 'error' ? 'failure' : (state === 'pending' ? null : 'unknown'));
    out.push({
      id: `status:${id}`,
      kind: 'status',
      name,
      checkedSha: queriedSha,
      status,
      conclusion,
      appId: null,
      creator: text(st.creator?.login),
      checkRunId: null,
      statusId: id,
      runId: null,
      attempt: null,
      jobId: null,
      startedAt: null,
      completedAt: text(st.updated_at) ?? text(st.created_at),
      observedAt,
      source: 'github:commit-statuses',
    });
  }
  return out;
}

const orderKey = (o) => [o.checkedSha, o.name, o.kind, String(o.checkRunId ?? o.statusId ?? 0).padStart(15, '0')].join('\u0000');

/**
 * normalize({ target, observedAt, pullRequest, commits, rules, branch, checkRuns, commitStatuses, jobs })
 *   pullRequest, commits: raw GraphQL / REST bodies. rules, branch: { body, gap } reads of the policy.
 *   checkRuns, commitStatuses: { [sha]: body } for each commit read. jobs: { [jobId]: body }.
 * Returns { pr, commits, policyInputs, observations, notes }.
 */
export function normalize({ target, observedAt, pullRequest, commits, rules, branch, checkRuns = {}, commitStatuses = {}, jobs = {} }) {
  const notes = [];
  const pr = pullRequestFrom(pullRequest);
  const shas = [];
  for (const c of Array.isArray(commits) ? commits : []) {
    const sha = validSha(c?.sha);
    if (sha) shas.push(sha);
    else notes.push('a commit in the PR list has no valid SHA, dropped');
  }
  const byId = new Map();
  const add = (o) => { if (!byId.has(o.id)) byId.set(o.id, o); };
  for (const [sha, body] of Object.entries(checkRuns)) {
    for (const o of checkRunObservations({ target, queriedSha: sha, body, jobs, observedAt, notes })) add(o);
  }
  for (const [sha, body] of Object.entries(commitStatuses)) {
    for (const o of statusObservations({ queriedSha: sha, body, observedAt, notes })) add(o);
  }
  const observations = [...byId.values()].sort((x, y) => (orderKey(x) < orderKey(y) ? -1 : orderKey(x) > orderKey(y) ? 1 : 0));
  return {
    pr,
    commits: shas,
    policyInputs: {
      base: pr?.baseRef ?? null,
      rules: Array.isArray(rules?.body) ? rules.body : null,
      rulesGap: rules?.gap ?? (Array.isArray(rules?.body) ? null : 'invalid_response'),
      branch: isObject(branch?.body) ? branch.body : null,
      branchGap: branch?.gap ?? (isObject(branch?.body) ? null : 'invalid_response'),
    },
    observations,
    notes,
  };
}
