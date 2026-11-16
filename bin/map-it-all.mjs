#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'touch') {
  // Hot path: this runs after every agent edit, so it must not load the whole CLI.
  // It reads the hook JSON from stdin, never throws, and always exits 0.
  const chunks = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
  let input = {};
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not hook JSON */ }
  const { handleEdit } = await import('../src/realtime.mjs');
  const out = await handleEdit(input, { bin: fileURLToPath(import.meta.url) });
  if (out) process.stdout.write(out);
  process.exit(0);
} else {
  const { main } = await import('../src/cli.mjs');
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
