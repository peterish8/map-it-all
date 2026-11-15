// Optional project config: `map-it-all.config.json` at the repo root. Everything has a default, so a
// repo with no config file works; the file exists to override detection.
//
//   {
//     "out": ".map-it-all",                       where the map, memory and handoff live
//     "historyDirs": [".planning", "archive"],     folders treated as history (skipped by docs, drift, debt)
//     "ignore": ["**/vendor/**"],                  extra globs to leave out of the map
//     "driftIgnore": ["^\\.mcp\\.json$"],          doc references (regex) the docs-drift check should not flag
//     "packs": "auto" | ["convex", "express", "expo"],
//     "convex": { "dir": "convex" },
//     "express": { "appFiles": ["server/app.ts"] },
//     "expo": { "dir": "apps/mobile" }
//   }

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'map-it-all.config.json';

export const DEFAULTS = {
  out: '.map-it-all',
  historyDirs: ['.planning', 'audit', 'archive', 'graft', 'output', '.claude', '.agents', '.cursor'],
  ignore: [],
  driftIgnore: [],
  packs: 'auto',
  convex: {},
  express: {},
  expo: {},
};

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let user = {};
  if (existsSync(file)) {
    try { user = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
    }
  }
  return {
    ...DEFAULTS,
    ...user,
    convex: { ...DEFAULTS.convex, ...user.convex },
    express: { ...DEFAULTS.express, ...user.express },
    expo: { ...DEFAULTS.expo, ...user.expo },
  };
}

/** Glob to RegExp for the small subset used here: `**`, `*`, `?`. */
export function globToRegExp(glob) {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\x00').replace(/\*\*/g, '\x01').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\x00/g, '(?:.*/)?').replace(/\x01/g, '.*');
  return new RegExp(`^${src}$`);
}
