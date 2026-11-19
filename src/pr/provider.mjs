// The provider boundary. Every PR read goes through one of two transports with the same contract:
//   - replay (MAP_IT_ALL_GH_REPLAY=<fixture>): offline, recorded, redacted, never starts a process;
//   - gh (default): read-only `gh api` calls by argv (src/pr/github.mjs).
// Callers depend only on createProvider(), read(op) and beginReconcile(). See contract.mjs for the gaps.

import { createReplayProvider } from './replay.mjs';

export { GAP, finalize, read } from './contract.mjs';
export { ReplayExhausted } from './replay.mjs';

/**
 * Pick the transport. The replay seam wins whenever MAP_IT_ALL_GH_REPLAY is set, so a test or a demo
 * cannot reach GitHub by accident.
 */
export function createProvider({ target, env = process.env } = {}) {
  if (env.MAP_IT_ALL_GH_REPLAY) return createReplayProvider({ target, file: env.MAP_IT_ALL_GH_REPLAY });
  throw new Error('gh transport is not wired yet');
}
