// Interactive, self-contained map page (.map-it-all/graph.html): a zoomable treemap of every file,
// coloured by map flags, with the importers, imports and callers of a selected file drawn as lines.
// No libraries, no network. Data is embedded as base64 so repo text can never break the page.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from './context.mjs';

const MAX_REFS = 15;

// Box area follows source size. Binary assets would drown the code, so they get a small fixed weight.
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|svg|mp4|mov|webm|mp3|wav|ogg|ttf|otf|woff2?|onnx|ort|so|apk|aab|jar|zip|gz|pdf|keystore|jks|bin|dll|exe|lock)$/i;

export function renderView({ root, stamp, results, files, hidden = [], embed = false }) {
  const sized = files.map((f) => {
    if (BINARY.test(f)) return [f, 600];
    try { return [f, statSync(path.join(root, f)).size]; } catch { return [f, 0]; }
  });
  const records = Object.values(results).flatMap((r) => r.records).map((r) => ({
    id: r.id, kind: r.kind, path: r.path, line: r.line, flags: r.flags, pub: Boolean(r.public),
    rc: r.refCount, pr: r.prodRefCount, total: r.total,
    refs: r.refs.slice(0, MAX_REFS).map((x) => [x.path, x.line, x.how]),
  }));
  const index = results.imports?.extra?.index ?? {};
  const data = { stamp: { head: stamp.head, branch: stamp.branch, repo: stamp.repo, generatedAt: stamp.generatedAt }, hidden, files: sized, records, imports: index };
  const b64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  return readFileSync(path.join(PKG_ROOT, 'src', 'view.template.html'), 'utf8')
    .replace('__EMBED__', embed ? 'true' : 'false')
    .replace('__DATA_B64__', () => b64);
}
