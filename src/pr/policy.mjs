// The policy evaluator: one verdict from a pinned pull request, the policy and the normalised observations.
// Pure: no I/O, no clock (time comes in as `now`), no model, no import. Only an observation for the current
// head OID can satisfy a required gate. Older results are listed as historical and never change the verdict.

const WINDOW_MINUTES = 15;
const PASSING = new Set(['success', 'neutral', 'skipped']);
const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const POLICY_OPERATION = /^(branchRules|branch):/;

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const nonNegativeInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * Policy from the normalised policy inputs: required contexts (with the app that must provide them, or null
 * for any source), approvals, and whether the policy was readable. Unreadable policy is never empty.
 */
export function derivePolicy(inputs) {
  const sources = [];
  const required = [];
  const approvals = [];
  const unreadable = [];
  const base = inputs.base ?? 'base';
  const noteSource = (source) => { if (!sources.includes(source)) sources.push(source); };
  const addRequired = (context, appId, source) => {
    if (typeof context !== 'string' || context.length === 0) return;
    if (!required.some((r) => r.context === context && r.appId === appId)) required.push({ context, appId, source });
  };
  let strictUpToDate = false;
  let requireConversationResolution = false;

  if (Array.isArray(inputs.rules)) {
    for (const rule of inputs.rules) {
      const source = `ruleset:${rule?.ruleset_id}`;
      if (rule?.type === 'required_status_checks') {
        if (rule.parameters?.strict_required_status_checks_policy === true) strictUpToDate = true;
        for (const check of rule.parameters?.required_status_checks ?? []) {
          noteSource(source);
          addRequired(check?.context, positiveInt(check?.integration_id), source);
        }
      }
      if (rule?.type === 'pull_request') {
        const count = nonNegativeInt(rule.parameters?.required_approving_review_count);
        if (count !== null) { noteSource(source); approvals.push(count); }
        if (rule.parameters?.required_review_thread_resolution === true) requireConversationResolution = true;
      }
    }
  } else {
    unreadable.push({ operation: `branchRules:${base}`, gap: inputs.rulesGap ?? 'unknown' });
  }

  if (inputs.branch && typeof inputs.branch === 'object') {
    if (inputs.branch.protected === true) {
      noteSource(`branch:${base}:protected`);
      const statusChecks = inputs.branch.protection?.required_status_checks;
      if (statusChecks && typeof statusChecks === 'object') {
        const checks = Array.isArray(statusChecks.checks)
          ? statusChecks.checks
          : (Array.isArray(statusChecks.contexts) ? statusChecks.contexts.map((context) => ({ context })) : []);
        for (const check of checks) addRequired(check?.context, positiveInt(check?.app_id), `branch:${base}`);
      }
      const reviews = nonNegativeInt(inputs.branch.protection?.required_pull_request_reviews?.required_approving_review_count);
      if (reviews !== null) approvals.push(reviews);
    } else {
      noteSource(`branch:${base}:unprotected`);
    }
  } else {
    unreadable.push({ operation: `branch:${base}`, gap: inputs.branchGap ?? 'unknown' });
  }

  const readable = unreadable.length === 0;
  return {
    coverage: readable ? 'complete' : 'unreadable',
    sources,
    required: required.map(({ context, appId }) => ({ context, appId })),
    requiredApprovals: readable ? (approvals.length ? Math.max(...approvals) : 0) : null,
    strictUpToDate,
    requireConversationResolution,
    unreadable,
  };
}

const newestFirst = (x, y) => (
  (y.attempt ?? 0) - (x.attempt ?? 0)
  || (y.completedAt ?? '').localeCompare(x.completedAt ?? '')
  || (y.checkRunId ?? y.statusId ?? 0) - (x.checkRunId ?? x.statusId ?? 0)
);

function classify(o) {
  if (o.status !== 'completed') return o.status === 'unknown' ? 'unknown' : 'running';
  if (o.conclusion === null || o.conclusion === 'unknown') return 'unknown';
  if (PASSING.has(o.conclusion)) return 'passed';
  if (o.conclusion === 'cancelled') return 'cancelled';
  if (FAILING.has(o.conclusion)) return 'failed';
  return 'unknown';
}

// A required context counts only from its expected source. Any-source contexts accept a check run or a status.
function gateFor(required, current) {
  const named = current.filter((o) => o.name === required.context);
  const accepted = named.filter((o) => required.appId === null || (o.kind === 'check_run' && o.appId === required.appId));
  const wrong = named.filter((o) => !accepted.includes(o));
  if (accepted.length === 0) return { outcome: wrong.length ? 'wrong_source' : 'missing', latest: null, wrong };
  const latest = [...accepted].sort(newestFirst)[0];
  return { outcome: classify(latest), latest, wrong };
}

const runFields = (o) => (o
  ? { checkRunId: o.checkRunId, statusId: o.statusId, runId: o.runId, attempt: o.attempt, jobId: o.jobId }
  : {});

/**
 * evaluate({ pr, policy, observations, now, observation, gaps, options })
 *   pr: the pinned pull request (headSha, headCommittedAt, state, isDraft, mergeable, mergeStateStatus, reviewDecision).
 *   observation: 'complete' unless a provider read failed. gaps: failed reads { operation, gap, status }.
 * Returns the verdict core: ready, state, dimensions, blockers, warnings, checks, requiredChecks.
 */
export function evaluate({ pr, policy, observations = [], now, observation = 'complete', gaps = [], options = {} }) {
  if (!pr) throw new TypeError('evaluate needs the pinned pull request');
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) throw new TypeError('evaluate needs now as an ISO-8601 string');
  const windowMinutes = options.registrationWindowMinutes ?? WINDOW_MINUTES;
  const head = pr.headSha;
  const headCommitted = pr.headCommittedAt ? Date.parse(pr.headCommittedAt) : null;
  const pastWindow = headCommitted !== null && Date.parse(now) - headCommitted > windowMinutes * 60_000;
  const current = observations.filter((o) => o.checkedSha === head);
  const historical = observations.filter((o) => o.checkedSha !== head);
  const blockers = [];
  const warnings = [];
  const requiredChecks = [];

  for (const u of policy.unreadable ?? []) {
    const failed = gaps.find((g) => g.operation === u.operation);
    blockers.push({ code: 'policy_unreadable', kind: 'unknown', operation: u.operation, gap: failed?.gap ?? u.gap, status: failed?.status ?? null });
  }
  for (const g of gaps) {
    if (POLICY_OPERATION.test(g.operation)) continue;
    blockers.push({ code: 'observation_incomplete', kind: 'unknown', operation: g.operation, gap: g.gap, status: g.status ?? null });
  }

  let requiredCi;
  if (policy.coverage !== 'complete') {
    requiredCi = 'unknown';
  } else if (policy.required.length === 0) {
    requiredCi = 'no_required_checks';
    blockers.push({ code: 'no_required_checks', kind: 'human', headSha: head });
  } else {
    for (const required of policy.required) {
      const gate = gateFor(required, current);
      requiredChecks.push({ context: required.context, appId: required.appId, outcome: gate.outcome, observationId: gate.latest?.id ?? null });
      const base = { context: required.context, expectedAppId: required.appId, headSha: head };
      if (gate.outcome === 'missing') {
        blockers.push({ code: 'required_check_missing', kind: 'waiting', ...base, pastRegistrationWindow: pastWindow });
        if (pastWindow) warnings.push({ code: 'required_check_missing_past_window', context: required.context, headSha: head, registrationWindowMinutes: windowMinutes });
      } else if (gate.outcome === 'wrong_source') {
        blockers.push({ code: 'required_check_wrong_source', kind: 'waiting', ...base, seenAppId: gate.wrong[0]?.appId ?? null, pastRegistrationWindow: pastWindow });
      } else if (gate.outcome === 'running') {
        blockers.push({ code: 'required_check_running', kind: 'waiting', ...base, ...runFields(gate.latest) });
      } else if (gate.outcome === 'failed') {
        blockers.push({ code: 'required_check_failed', kind: 'action', ...base, conclusion: gate.latest.conclusion, ...runFields(gate.latest) });
      } else if (gate.outcome === 'cancelled') {
        blockers.push({ code: 'required_check_cancelled', kind: 'action', ...base, ...runFields(gate.latest) });
      } else if (gate.outcome === 'unknown') {
        blockers.push({ code: 'observation_incomplete', kind: 'unknown', ...base, ...runFields(gate.latest) });
      }
    }
    const outcomes = requiredChecks.map((r) => r.outcome);
    if (outcomes.includes('unknown')) requiredCi = 'unknown';
    else if (outcomes.includes('failed') || outcomes.includes('cancelled')) requiredCi = 'failing';
    else if (outcomes.every((o) => o === 'passed')) requiredCi = 'green';
    else requiredCi = 'pending';
  }

  let reviews;
  const decision = pr.reviewDecision;
  const needed = policy.requiredApprovals;
  if (decision === 'CHANGES_REQUESTED') {
    reviews = 'actionable';
    blockers.push({ code: 'changes_requested', kind: 'action', headSha: head });
  } else if (needed === null) {
    reviews = decision === 'APPROVED' ? 'satisfied' : 'unknown';
  } else if (needed === 0) {
    reviews = 'not_required';
  } else if (decision === 'APPROVED') {
    reviews = 'satisfied';
  } else {
    reviews = 'waiting';
    blockers.push({ code: 'review_required', kind: 'human', requiredApprovals: needed, reviewDecision: decision, headSha: head });
  }
  if (policy.requireConversationResolution && (pr.unresolvedThreads > 0 || pr.threadsTruncated)) {
    blockers.push({ code: 'unresolved_threads', kind: 'action', count: pr.unresolvedThreads, headSha: head });
  }

  const open = pr.state === 'open';
  const draft = open && pr.isDraft === true;
  if (draft) blockers.push({ code: 'draft', kind: 'action', headSha: head });
  let merge;
  if (!open) {
    merge = 'unknown';
  } else if (pr.mergeQueued) {
    merge = 'queued';
  } else if (pr.mergeable === 'conflicting' || pr.mergeStateStatus === 'DIRTY') {
    merge = 'conflicting';
    blockers.push({ code: 'merge_conflict', kind: 'action', headSha: head });
  } else if (pr.mergeable === 'unknown' || pr.mergeStateStatus === 'UNKNOWN') {
    merge = 'computing';
    blockers.push({ code: 'merge_state_computing', kind: 'waiting', headSha: head });
  } else if (draft || pr.mergeStateStatus === 'DRAFT') {
    merge = 'blocked';
  } else if (pr.mergeStateStatus === 'BEHIND') {
    merge = policy.strictUpToDate ? 'behind' : 'mergeable';
    if (policy.strictUpToDate) blockers.push({ code: 'behind_base', kind: 'action', headSha: head });
  } else if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'UNSTABLE' || pr.mergeStateStatus === 'HAS_HOOKS') {
    merge = 'mergeable';
  } else if (pr.mergeStateStatus === 'BLOCKED') {
    merge = 'blocked';
  } else {
    merge = 'unknown';
  }
  // A BLOCKED merge (or one we cannot read) must be explained by a blocker, or it is an unknown gate.
  if ((merge === 'blocked' || merge === 'unknown') && open && blockers.length === 0) {
    blockers.push({ code: 'merge_blocked_unexplained', kind: 'unknown', mergeStateStatus: pr.mergeStateStatus, headSha: head });
  }

  const prDimension = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : (draft ? 'draft' : (open ? 'open' : 'unknown'));
  const dimensions = { observation, pr: prDimension, requiredCi, reviews, merge };
  const gatesSatisfied = observation === 'complete' && open && !draft && requiredCi === 'green'
    && (reviews === 'not_required' || reviews === 'satisfied') && merge === 'mergeable';
  const ready = gatesSatisfied && blockers.length === 0;

  let state;
  if (pr.state === 'merged') state = 'merged';
  else if (pr.state === 'closed') state = 'closed';
  else if (observation !== 'complete') state = 'interrupted';
  else if (blockers.some((b) => b.kind === 'action')) state = 'needs_action';
  else if (blockers.some((b) => b.kind === 'human' || b.kind === 'unknown')) state = 'needs_human';
  else if (ready) state = 'ready';
  else state = 'observing';

  const contexts = new Set(policy.required.map((r) => r.context));
  const basis = 'head_committed_date';
  const shape = (o, appliesTo, reason, arrivedAfterHeadChange) => ({
    kind: o.kind,
    name: o.name,
    checkedSha: o.checkedSha,
    conclusion: o.conclusion,
    checkRunId: o.checkRunId,
    statusId: o.statusId,
    runId: o.runId,
    attempt: o.attempt,
    jobId: o.jobId,
    appId: o.appId,
    creator: o.creator,
    completedAt: o.completedAt,
    appliesTo,
    reason,
    arrivedAfterHeadChange,
  });
  const arrivedLate = (o) => headCommitted !== null && o.completedAt !== null && Date.parse(o.completedAt) > headCommitted;

  return {
    ready,
    state,
    dimensions,
    blockers,
    warnings,
    checks: {
      basis,
      current: current.map((o) => shape(o, contexts.has(o.name) ? 'requiredCi' : 'none', null, false)),
      historical: historical.map((o) => shape(o, 'none', 'checked_sha_not_current_head', arrivedLate(o))),
    },
    requiredChecks,
  };
}
