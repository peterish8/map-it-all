# Contributing

```bash
npm install
npm test
```

Zero-build ESM on Node 20+, no runtime dependency except ast-grep. Please keep it that way: a tool that agents run on every session should be cheap to install and easy to audit.

## Ground rules

- **A flag is a lead, not proof.** Never word output so an agent can read "no refs" as "safe to delete". Public surface says VERIFY.
- **Every new registration style gets a fixture and an assertion that fails without it** (`test/fixtures.mjs`, `test/map.test.mjs`). Mutate your change away once and confirm the test goes red.
- **Check against a real repo.** `map-it-all check` compares ast-grep results with plain regex counts; a new rule should agree on a project you did not write.
- **Keep the MCP surface small.** Tool definitions cost tokens on every request. New capability should usually be an argument of an existing tool. Run `map-it-all tokens` and say what your change costs.
- **No network, no telemetry, nothing outside the project folder** except the temporary rule files in the OS temp dir.
- **stdout is for MCP protocol messages only** inside the server.

## Layout

```
bin/            CLI entry
src/            context, imports, build, store, memory, brief, mcp, view, cli, doctor
src/packs/      convex, express, expo (detect + extract)
src/extractors/ docs, drift, debt, tooling, knip
test/           node:test, fixtures build a throwaway project
docs/           agents, memory, packs, rtk
```
