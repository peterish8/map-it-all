// Evidence IDs and span expansion. An ID is `ev:<path>:<line>`. Paths never contain ":" (resolveInside refuses
// it), so the line is the part after the last colon. Expansion reads the working tree through resolveInside.

import { readFileSync } from 'node:fs';
import { PathError, resolveInside } from '../paths.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

export const evidenceId = ({ path, line }) => `ev:${path}:${line}`;

/** `ev:<path>:<line>` -> { path, line }, or throws `{ code: 'bad_evidence_id' }`. */
export function parseEvidenceId(id) {
  const m = /^ev:(.+):([1-9]\d*)$/.exec(typeof id === 'string' ? id : '');
  if (!m) throw fail('bad_evidence_id', `bad evidence id "${id}": expected ev:<path>:<line>`);
  return { path: m[1], line: Number(m[2]) };
}

/** The absolute path for an evidence path, or `path_outside_root` / `path_not_found`. */
export function resolveEvidencePath(root, rel) {
  try {
    return resolveInside(root, rel, { allowMissing: false });
  } catch (error) {
    if (!(error instanceof PathError)) throw error;
    throw fail(error.reason === 'does not exist' ? 'path_not_found' : 'path_outside_root', `"${rel}" ${error.reason}`);
  }
}

/**
 * The lines around an evidence ID: ±10 lines, clipped to the file and to `maxLines`. Returns
 * { id, path, startLine, endLine, text }. A line past the end of the file throws `line_out_of_range`.
 */
export function expandEvidence({ root, id, maxLines = 60 }) {
  const { path: rel, line } = parseEvidenceId(id);
  const text = readFileSync(resolveEvidencePath(root, rel), 'utf8').replaceAll('\r\n', '\n');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (line > lines.length) throw fail('line_out_of_range', `${rel} has ${lines.length} lines; ${line} is past the end`);
  const startLine = Math.max(1, line - 10);
  const endLine = Math.min(lines.length, line + 10, startLine + maxLines - 1);
  return { id, path: rel, startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
}
