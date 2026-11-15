// `map-it-all doctor`: is this machine and project ready, and what would make agents cheaper to run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { outDirFor, isFresh } from './build.mjs';
import { loadConfig } from './config.mjs';
import { git, PKG_ROOT } from './context.mjs';

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...options });
  return r.error || r.status !== 0 ? null : (r.stdout || r.stderr).trim();
}

// Install commands from the RTK README (github.com/rtk-ai/rtk): re-check there before relying on them.
const RTK_INSTALL = {
  win32: 'winget install rtk-ai.rtk',
  darwin: 'brew install rtk',
  linux: 'brew install rtk   (or: curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh)',
};

export function doctor(root) {
  root = path.resolve(root);
  const config = loadConfig(root);
  const out = outDirFor(root, config);
  const rows = [];
  const add = (status, name, detail = '') => rows.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', 'Node', `${process.versions.node}${major >= 20 ? '' : ' (need 20 or newer)'}`);

  add(git(root, ['rev-parse', '--is-inside-work-tree']) !== null ? 'ok' : 'warn', 'Git repository', git(root, ['rev-parse', '--is-inside-work-tree']) !== null ? root : 'not a git repo: the map still works, but freshness checks use a directory scan');

  const sgDir = [path.join(PKG_ROOT, 'node_modules'), path.dirname(PKG_ROOT), path.join(root, 'node_modules')]
    .map((m) => path.join(m, '@ast-grep', 'cli')).find((d) => existsSync(path.join(d, 'package.json')));
  if (process.env.AST_GREP_BIN) add('ok', 'ast-grep', `AST_GREP_BIN=${process.env.AST_GREP_BIN}`);
  else if (sgDir) {
    const bin = path.join(sgDir, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
    const v = existsSync(bin) ? run(bin, ['--version']) ?? run(process.execPath, [bin, '--version']) : null;
    add(v ? 'ok' : 'fail', 'ast-grep', v ?? 'installed but not runnable: reinstall with `npm install`');
  } else add('fail', 'ast-grep', 'not installed: run `npm install` in the map-it-all folder');

  add(existsSync(path.join(root, 'node_modules', 'knip', 'package.json')) ? 'ok' : 'info', 'Knip (optional)', existsSync(path.join(root, 'node_modules', 'knip', 'package.json')) ? 'found: `build --with-knip` works' : 'not in this project: only needed for `build --with-knip`');

  const gi = existsSync(path.join(root, '.gitignore')) ? readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
  add(gi.split('\n').some((l) => l.trim().replace(/^\//, '').startsWith(config.out)) ? 'ok' : 'warn', '.gitignore', gi.includes(config.out) ? `${config.out}/ is ignored` : `add ${config.out}/ to .gitignore (the map and memory are local); \`init --write\` does it`);

  add(existsSync(path.join(out, 'stamp.json')) ? (isFresh(root, out) ? 'ok' : 'info') : 'info', 'Map', existsSync(path.join(out, 'stamp.json')) ? (isFresh(root, out) ? `fresh in ${config.out}/` : 'present but the tree changed since: it rebuilds on next use') : 'not built yet: run `map-it-all build`');

  const rtk = run('rtk', ['--version']);
  if (rtk) add('ok', 'RTK (command-output compression)', `${rtk}. Savings so far: \`rtk gain\`. Hook into your agent once with \`rtk init -g\`, then restart it.`);
  else add('info', 'RTK (command-output compression)', `not installed. It trims noisy shell output (tests, git, installs) before it reaches the model; map-it-all does not need it. Install: ${RTK_INSTALL[process.platform] ?? RTK_INSTALL.linux}, then \`rtk init -g\`.`);

  const icon = { ok: '[ok]  ', fail: '[FAIL]', warn: '[warn]', info: '[--]  ' };
  const text = rows.map((r) => `${icon[r.status]} ${r.name}${r.detail ? `: ${r.detail}` : ''}`).join('\n');
  return { ok: !rows.some((r) => r.status === 'fail'), text };
}
