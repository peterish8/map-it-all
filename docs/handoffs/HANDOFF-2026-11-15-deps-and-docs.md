# Handoff: dependencies (`deps`) and version-pinned docs (`docs`)

Date: 2026-11-15. Branch: `feat/deps-and-docs` (from `main` at `84d218a`). Repo: https://github.com/peterish8/map-it-all (MIT, public).

## 1. Read first

1. This file.
2. `docs/handoffs/STARTER-PROMPT-deps-and-docs.md` (the work order).
3. `README.md` sections "Dependencies" and "Quickstart", `SECURITY.md`, `CHANGELOG.md` (`[Unreleased]`).
4. Source, in this order: `src/net.mjs` (the only network code), `src/lock.mjs`, `src/extractors/deps.mjs`, `src/advisories.mjs`, `src/deps.mjs`, `src/docs.mjs`, then the wiring in `src/build.mjs`, `src/imports.mjs`, `src/memory.mjs`, `src/mcp.mjs`, `src/cli.mjs`, `src/brief.mjs`.
5. `test/deps.test.mjs` (what is already proven).

## 2. Project context

MAP-IT-ALL: a zero-config local map of a codebase for AI coding agents, served over MCP and a CLI. Node 20+, ESM, one runtime dependency (`@ast-grep/cli`), no build step. Layout: `bin/map-it-all.mjs` (entry), `src/` (build, store, MCP server, CLI, init, realtime, memory, brief, packs, extractors), `test/` (node:test), `docs/`, `examples/demo-app`.

Commands (from the repo root):

```bash
npm install
npm test                                   # node --test "test/*.test.mjs"; 41 tests at this commit
node bin/map-it-all.mjs deps --root <project> --out <tmp>     # offline inventory
node bin/map-it-all.mjs deps --online --root <project> ...    # allow OSV + registry lookups for this run
node bin/map-it-all.mjs tokens --root <project> --out <tmp>   # MCP tool-definition cost per profile
```

## 3. Goal and status

Goal: make the map useful for dependency problems without breaking its "local, cheap, offline by default" promise. Two features:

1. **`deps`**: join each declared package to the files that import it (offline, part of the build), then, only if the user allows it, add OSV advisories and npm deprecations, and trace a vulnerable *transitive* package back to the direct dependency that pulls it in and from there to the user's own files.
2. **`docs`**: a short, query-ranked docs excerpt for the *installed* version (package `llms.txt`, else GitHub README), saved as a memory note pinned to `name@version` that flags itself `stale` when the version changes.

Status: both are implemented and covered by `test/deps.test.mjs` against a local fake OSV/registry server. **Nothing has been run against the real OSV, npm registry, llms.txt or GitHub.** The branch is pushed for review and continuation; it is not merged and not released.

## 4. Decisions and approvals

| Date | Decision | User's words (short) | Status |
| --- | --- | --- | --- |
| 2026-11-15 | Build both features (deps/advisories and docs) | "ok these two ... u code in map it all folder" | approved |
| 2026-11-15 | Reuse ideas only, write our own implementation, no copied code | "we just saw the logic and wrote in our own efficient way" | approved; true as built, keep it true |
| 2026-11-15 | Commit to a branch on the GitHub remote for a cloud session | "commit all to gh remote properly ... branch name" | approved, done |
| 2026-11-15 | Network off by default; the user (not an agent) enables it | design decision, in README and SECURITY.md | made by the assistant, not yet explicitly reviewed by the user |
| earlier | No npm publish, no MCP-registry publish without explicit go-ahead | standing rule | in force |

The agent may: edit code and docs on this branch, run tests, commit and push to this branch. It may not: merge to `main`, tag a release, publish to npm or the MCP registry, or force-push, without the user.

## 5. What was done this session

- `src/lock.mjs` (new): lockfile readers for `package-lock.json` (v1 to v3), `yarn.lock` classic and `pnpm-lock.yaml`, normalised to `direct / info / depsOf / ids`. pnpm has no dependency edges (`depsOf` is empty), so transitive attribution works for npm and yarn only.
- `src/imports.mjs`: `scanImports` returns `{ reverse, externals }` in the same single pass; `packageName(spec)`; `buildImportGraph` kept as a wrapper.
- `src/extractors/deps.mjs` (new, runs in the build, offline): kind `dependency`, id `dep:<name>`, `versions`, `dev`, `declaredIn`, `bins`, refs = importing files. Production dependencies nothing imports, no script runs and no config names get `no-refs`. `@types/*`, dev dependencies and workspace/`file:`/`git` ranges are never leads. Stats include `depsLockSig`.
- `src/build.mjs`: runs the `deps` extractor; `GENERATOR_VERSION` is now 3 so old maps rebuild.
- `src/net.mjs` (new): network policy (`--online`, `"network": true`, `MAP_IT_ALL_ONLINE=1`; `MAP_IT_ALL_OFFLINE=1` wins), `fetchText` with timeout, size cap, manual redirects, and an SSRF guard (`assertPublicUrl`: https only, no localhost/private/link-local, DNS checked). Generic user agent, no personal data.
- `src/advisories.mjs` (new): OSV `querybatch` for the whole lockfile (chunks of 500, pagination), then `/v1/vulns/<id>` per distinct id; own CVSS 3.x calculator; npm registry deprecation/homepage/repository; cache `.map-it-all/deps-cache.json` keyed by `name@version` (TTL 24 h for matches, 7 days for details and registry).
- `src/deps.mjs` (new): the tool. Lists vulnerable packages worst first, `[direct]` or `[via X]`, with the files exposed and how many hold public records; deprecations; possibly unused production dependencies; per-package detail; `docs` hook; `depsSummary` for the brief; `versionOfFrom` for memory pins.
- `src/docs.mjs` (new): `excerptMarkdown`, `excerptLlms`, `fetchDocs`, `docsFor` (reads a saved note first; fetches only if allowed).
- `src/memory.mjs`: notes can carry `pins: [{pkg, version}]`; `createMemory({ versionOf })`; a changed version makes a note `stale`, a removed package `orphaned`; `confirm` re-pins.
- `src/mcp.mjs`: `deps` tool in `standard` and `full` (about 214 tokens), `allowOnline` option, `file` tool summarises dependency records instead of listing them. `src/cli.mjs`: `deps` and `docs` commands, `--only`, `--online`, `--refresh`, `mcp --online`. `src/brief.mjs`: one dependency line. `src/config.mjs`: `network: false` default. `src/store.mjs`: skips `deps-cache.json`.
- Docs: README (Dependencies section, token numbers 670 / 1,490 / 1,610, badge "network off by default", FAQ), SECURITY.md, CHANGELOG, `docs/agents.md`.
- Tests: `test/deps.test.mjs` (8 tests); `test/mcp.test.mjs` updated for the `deps` tool and Windows `rmSync` retries.

## 6. Where everything lives

| Thing | Where |
| --- | --- |
| Lockfile readers | `src/lock.mjs` |
| Offline extractor | `src/extractors/deps.mjs` |
| Network gate and safe fetch | `src/net.mjs` |
| OSV, CVSS, npm registry, cache | `src/advisories.mjs` |
| The tool and brief line | `src/deps.mjs` |
| Docs excerpts and pinned notes | `src/docs.mjs`, `src/memory.mjs` |
| Tests | `test/deps.test.mjs`, `test/mcp.test.mjs` |
| Runtime output | `.map-it-all/deps.json` (records), `.map-it-all/deps-cache.json` (network cache) |

## 7. How to work with it

- Offline check on any repo: `node bin/map-it-all.mjs deps --root <repo> --out <tmp>`. On a 2,500-file repo with two lockfiles (107 direct, 1,519 installed copies) it ran offline and listed seven possibly-unused production dependencies.
- Online check (sends package names and versions to OSV.dev and registry.npmjs.org): add `--online`. Use `--refresh` to ignore the cache.
- Tests point the clients at a local server with `MAP_IT_ALL_OSV_URL` and `MAP_IT_ALL_NPM_URL`. Those two base URLs are trusted (not SSRF-checked); every other URL is.
- Gotchas: lockfiles are skipped by the file scan, so `src/lock.mjs` reads them from disk. On Windows, tests that spawn processes can hit `EPERM` on `rmSync`; use `maxRetries: 20, retryDelay: 150`.

## 8. Verified facts

- 41 of 41 tests pass at this commit (`npm test`).
- `node bin/map-it-all.mjs tokens` reports standard 11 tools about 1,487 tokens, full 13 tools about 1,611, minimal unchanged at about 668.
- CVSS 3.1 vectors tested: `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` is 9.8, `S:C` variant 10.0, `UI:R/S:C/C:L/I:L/A:N` 6.1.
- The OSV FAQ states the API currently has no rate limit (checked 2026-11-15). Licences checked through the GitHub API on 2026-11-15: osv.dev and osv-scanner Apache-2.0, Context7 MIT, llms-txt Apache-2.0, GitHub Advisory Database CC-BY-4.0. This is not legal advice.
- **Not verified:** real responses from OSV and the registry (field names are from OSV's published schema and docs, tested only against a fake), `fetchDocs` against real sites, the `querybatch` maximum batch size (the code uses 500, which should be safe), pnpm lockfile variants other than v6+/v9 importers.

## 9. Known problems and findings

1. No real-network test exists. First real run may show schema surprises (for example `database_specific.severity` casing, or advisories with only a CVSS v4 vector, which this code reports as `UNKNOWN`).
2. `src/docs.mjs` `fetchDocs` is untested end to end. Excerpt selection is tested; the fetch chain is not.
3. pnpm: versions and advisories work, "via X" attribution does not (no edges). Yarn Berry (`yarn.lock` v2+), Bun and `npm-shrinkwrap` quirks are unsupported.
4. `peerDependencies` are collected by the extractor but never count as production. Workspace packages and non-registry ranges are skipped.
5. Vulnerable `devDependencies` are reported like any other. Consider marking dev-only findings as lower priority.
6. The `deps` tool has no MCP-level test yet (`test/mcp.test.mjs` only checks that it is listed).
7. Test flake on Windows (`EPERM` on temp-folder cleanup) was seen once in `mcp.test.mjs` and fixed with retries; other test files may still be exposed.
8. README anchor `#dependencies` is used in the FAQ and is new; check that it resolves on GitHub.

## 10. Remaining work, prioritised

1. Run `deps --online` on a real project and fix whatever the real OSV and registry responses change. Done means: sensible output on a repo with at least one known advisory, and a fixture of a real (trimmed) OSV response added to `test/`.
2. Test `fetchDocs` for real: one package with `llms.txt`, one with only a GitHub README. Done means: `docs <pkg> "<question>"` returns a useful excerpt, saves a pinned note, and a lockfile bump flags it stale.
3. MCP-level test for the `deps` tool (offline notice, `refresh` cannot enable the network, online path with the fake server).
4. `docs/deps.md` with the full options, the cache layout and the privacy model; link it from README.
5. `doctor`: show network policy and cache age. `init --online` that writes `"network": true`. Optional realtime note when a lockfile or `package.json` is edited.
6. Provider adapters (Context7, Firecrawl, Context.dev) behind a small interface in `src/docs.mjs`. Verify each service's current API from its own docs before coding; do not guess endpoints. Keys come from env vars the user names in config; never commit keys.
7. pnpm edges (`snapshots:` section) and Yarn Berry.
8. Bump to 0.2.0, tag, release notes. Needs the user's go-ahead. npm and MCP-registry publishing also need it.

## 11. Plan for the next agent

1. `git fetch && git switch feat/deps-and-docs && npm install && npm test` (expect 41 passing).
2. Remaining work item 1, then 2, then 3, each as its own commit with a test.
3. Docs and `doctor` (items 4 and 5). Keep README token numbers in sync with `map-it-all tokens`.
4. Open a PR into `main` titled "feat: dependencies and version-pinned docs" and let CI run (`.github/workflows/ci.yml`, Node matrix). Ask the user before merging.

## 12. Open questions (defaults)

- Should dev-only vulnerabilities be listed separately? Default: yes, a short second list after production findings.
- Should `network` ever be settable by `init`? Default: only with an explicit `init --online` flag.
- Provider adapters: build only what the user asks for. Default: skip until requested.

## 13. Rules and guardrails

- The implementation is original code written against public APIs and the OSV schema. Do not copy code from osv-scanner, Context7 or any other project. If code is ever copied, keep its licence and notice, and tell the user first.
- Keep crediting the data: OSV.dev / GitHub Advisory Database (CC BY 4.0) appears in tool output and the README. Do not remove it.
- The network stays off by default and only the user can turn it on. Only package names and versions may be sent. Remote text is untrusted: clean it, cap it, never execute it, never put it in instructions.
- Commits use the GitHub no-reply identity (already set in this repo's local git config: `181628466+peterish8@users.noreply.github.com`). Never use a personal email. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not put personal paths, usernames, emails or private project names in any committed file. Before every push, grep the diff and the tree for local absolute paths, usernames, personal email addresses and the names of private projects. Ask the user for the list of terms; do not write that list into this repo.
- Edit code with the Edit tool, not scripted rewrites. Do not publish to npm or the MCP registry. Do not merge or tag without the user.

## 14. Continuation instruction

Check out `feat/deps-and-docs`, run `npm test`, then start with remaining work item 1 (a real `--online` run). Keep each step small, tested and committed, and report back to the user after items 1 to 3 before moving on.
