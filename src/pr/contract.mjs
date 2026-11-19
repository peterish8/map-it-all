// The read contract every provider transport answers (replay and gh), and the vocabulary of gaps.
// A read returns { status, body, gap, message }. `gap` is null when the read is usable as evidence.
// Both transports pass their raw answer through finalize(), so one set of rules classifies both.

export const GAP = Object.freeze({
  AUTH: 'auth',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found_or_no_access',
  PROVIDER: 'provider_error',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
  NOT_RECORDED: 'not_recorded',
  INVALID: 'invalid_response',
});

export function read(status, body, { gap = null, message = '' } = {}) {
  return { status, body, gap, message };
}

/** HTTP status to gap. 200 has no gap. Rate limits are told apart by the transport (it sees the text). */
export function gapForStatus(status) {
  if (status === 200) return null;
  if (status === 401) return GAP.AUTH;
  if (status === 403 || status === 429) return GAP.FORBIDDEN;
  if (status === 404 || status === 410) return GAP.NOT_FOUND;
  return GAP.PROVIDER;
}

const short = (text) => String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);

/**
 * Classify a raw answer { status, body, gap?, message? } for operation `op`.
 * - a transport that already knows the gap keeps it;
 * - a non-200 status becomes its gap;
 * - a GraphQL body with `errors` is not found when the pull request is null, partial when repository data is
 *   present, and a provider error otherwise (the data is kept so callers can see what arrived);
 * - a 200 without a JSON body is an invalid response, never an empty success.
 */
export function finalize(op, raw) {
  if (raw.gap) return read(raw.status, raw.body ?? null, { gap: raw.gap, message: raw.message ?? '' });
  if (raw.status !== 200) return read(raw.status, raw.body ?? null, { gap: gapForStatus(raw.status), message: raw.message || `HTTP ${raw.status}` });
  const body = raw.body;
  if (body === null || typeof body !== 'object') {
    return read(200, null, { gap: GAP.INVALID, message: `${op} returned no JSON body` });
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    const first = short(body.errors[0]?.message ?? 'GraphQL error');
    const repository = body.data?.repository;
    if (repository && repository.pullRequest === null) return read(200, body, { gap: GAP.NOT_FOUND, message: `${op}: ${first}` });
    if (repository && typeof repository === 'object') return read(200, body, { gap: GAP.PARTIAL, message: `${op}: ${first}` });
    return read(200, body, { gap: GAP.PROVIDER, message: `${op}: ${first}` });
  }
  return read(200, body);
}
