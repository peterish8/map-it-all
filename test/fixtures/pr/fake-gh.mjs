#!/usr/bin/env node
// Test double for the gh CLI. It records its argv (FAKE_GH_LOG, one JSON array per line) and answers from the
// JSON file named by FAKE_GH_SCRIPT. The key is "graphql" for GraphQL calls, otherwise the REST endpoint
// (query string removed). An answer is { stdout, stderr, code }. A key with no answer fails like a 404.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(argv)}\n`);

const last = argv[argv.length - 1] ?? '';
const key = argv.includes('graphql') ? 'graphql' : last.split('?')[0];
const script = JSON.parse(readFileSync(process.env.FAKE_GH_SCRIPT, 'utf8'));
const answer = script[key] ?? { code: 1, stderr: `gh: no fake answer for ${key} (HTTP 404)\n` };

if (answer.stdout) process.stdout.write(answer.stdout);
if (answer.stderr) process.stderr.write(answer.stderr);
process.exitCode = answer.code ?? 0;
