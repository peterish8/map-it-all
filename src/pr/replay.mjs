// Offline provider: answers each logical operation from a recorded, redacted fixture file (MAP_IT_ALL_GH_REPLAY).
// It never touches the network and never starts a process. An operation the fixture does not list is a
// capability gap (404 not_recorded), so a fixture cannot pass by omission.
//
// Shape: `operations` is one recorded state. A `timeline` (array of { operations }) is an ordered list of
// states; beginReconcile() moves to the next one. An operation may be an array: the first call gets the first
// entry, later calls the next, and the last entry repeats (used for a head that moves during collection).

import { readFileSync, statSync } from 'node:fs';
import { finalize, GAP, read } from './contract.mjs';
import { PrUsageError } from './target.mjs';

export class ReplayExhausted extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayExhausted';
  }
}

const KIND = 'pratzystack.github-replay';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function loadReplay(file) {
  let stat;
  try { stat = statSync(file); } catch { throw new PrUsageError('MAP_IT_ALL_GH_REPLAY does not point to a file.'); }
  if (!stat.isFile()) throw new PrUsageError('MAP_IT_ALL_GH_REPLAY does not point to a regular file.');
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new PrUsageError('The replay fixture is not valid JSON.'); }
  if (!isObject(doc) || doc.kind !== KIND) throw new PrUsageError(`The replay fixture is not a ${KIND} file.`);
  if (doc.schemaVersion !== 1) throw new PrUsageError(`Unsupported replay schemaVersion ${JSON.stringify(doc.schemaVersion)}; expected 1.`);
  if (typeof doc.scenario !== 'string' || !doc.scenario) throw new PrUsageError('The replay fixture needs a scenario name.');
  if (typeof doc.now !== 'string' || Number.isNaN(Date.parse(doc.now))) throw new PrUsageError('The replay fixture needs an ISO-8601 "now".');
  if (!isObject(doc.target)) throw new PrUsageError('The replay fixture needs a target.');
  if (doc.timeline !== undefined) {
    if (!Array.isArray(doc.timeline) || doc.timeline.length === 0 || !doc.timeline.every((s) => isObject(s) && isObject(s.operations))) {
      throw new PrUsageError('The replay timeline must be a non-empty list of { "operations": {...} } steps.');
    }
  } else if (!isObject(doc.operations)) {
    throw new PrUsageError('The replay fixture needs an operations object or a timeline.');
  }
  return doc;
}

function answerFor(entry, op) {
  if (!isObject(entry) || !Number.isInteger(entry.status)) {
    return read(0, null, { gap: GAP.PROVIDER, message: `${op}: the replay entry has no integer status` });
  }
  return finalize(op, { status: entry.status, body: entry.body ?? null });
}

export function createReplayProvider({ target, file }) {
  const doc = loadReplay(file);
  const want = `${target.owner}/${target.repo}#${target.number}`.toLowerCase();
  const have = `${doc.target.owner}/${doc.target.repo}#${doc.target.number}`.toLowerCase();
  if (want !== have) throw new PrUsageError(`The replay is for ${doc.target.owner}/${doc.target.repo}#${doc.target.number}, not ${target.repository}#${target.number}.`);

  const steps = doc.timeline ? doc.timeline.map((s) => s.operations) : [doc.operations];
  let step = 0;
  const cursors = new Map();

  return {
    name: 'replay',
    scenario: doc.scenario,
    now: doc.now,
    read(op) {
      const ops = steps[step];
      if (!hasOwn(ops, op)) {
        return read(404, null, { gap: GAP.NOT_RECORDED, message: `${op} is not in the replay fixture` });
      }
      const entry = ops[op];
      if (!Array.isArray(entry)) return answerFor(entry, op);
      if (entry.length === 0) return read(0, null, { gap: GAP.PROVIDER, message: `${op}: the replay sequence is empty` });
      const index = cursors.get(op) ?? 0;
      cursors.set(op, index + 1);
      return answerFor(entry[Math.min(index, entry.length - 1)], op);
    },
    /** The seam reconcile uses. A timeline advances one step; a single recorded state has nothing to advance. */
    beginReconcile() {
      if (!doc.timeline) return;
      if (step + 1 >= steps.length) throw new ReplayExhausted(`the replay has no step after step ${step + 1} of ${steps.length}`);
      step += 1;
      cursors.clear();
    },
  };
}
