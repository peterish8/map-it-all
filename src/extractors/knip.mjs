// Optional (`build --with-knip`): Knip candidates, normalised. Knip must be installed in the analysed
// project (it is not a dependency of map-it-all). Slow, so it is not part of the default build.
// Knip output is a candidate list, never proof.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { finalize, norm } from '../records.mjs';

function knipBin(root) {
  const dir = path.join(root, 'node_modules', 'knip');
  if (!existsSync(path.join(dir, 'package.json'))) return null;
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return path.join(dir, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.knip);
}

export function extract(ctx, graph, resolver) {
  const records = [];
  const notes = [];
  const bin = knipBin(ctx.root);
  if (!bin || !existsSync(bin)) return { records, notes: ['knip is not installed in this project; run `npm install -D knip`'] };

  // Knip does not follow every alias; the map's own import index does. A knip "unused file" that the
  // index shows importers for is almost certainly a false positive, so say so on the record.
  const contradicted = (p) => (graph?.get(p) ?? []).some((i) => !ctx.isTest(i.path));

  const workspaces = resolver?.workspaceDirs ?? [];
  const runs = workspaces.length ? workspaces.map((w) => ({ base: '', args: ['--workspace', w] })) : [{ base: '', args: [] }];
  for (const run of runs) {
    const r = spawnSync(process.execPath, [bin, ...run.args, '--reporter', 'json', '--no-progress'], {
      cwd: ctx.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000,
    });
    let report;
    try { report = JSON.parse(r.stdout); } catch {
      notes.push(`knip ${run.args.join(' ')}: no JSON output (exit ${r.status}): ${(r.stderr || '').slice(0, 160)}`);
      continue;
    }
    for (const file of report.files ?? []) {
      const p = norm(file);
      const flags = contradicted(p) ? ['knip-unused-file', 'map-has-importers'] : ['knip-unused-file'];
      records.push(finalize({ id: `knip:${p}`, kind: 'knip', name: p, path: p, line: 1, public: false, entry: true, source: 'knip', refs: [], flags }, ctx));
    }
    for (const issue of report.issues ?? []) {
      const p = norm(issue.file);
      for (const [category, list] of Object.entries(issue)) {
        if (category === 'file' || !Array.isArray(list)) continue;
        for (const item of list) {
          const name = item.name ?? item.symbol ?? '?';
          records.push(finalize({
            id: `knip:${p}#${category}:${name}`, kind: 'knip', name, path: p, line: item.line ?? 1, public: false, entry: true,
            source: 'knip', refs: [], flags: [`knip-unused-${category}`],
          }, ctx));
        }
      }
    }
  }
  return { records, notes };
}
