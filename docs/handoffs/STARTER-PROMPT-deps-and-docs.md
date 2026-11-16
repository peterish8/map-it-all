# Starter prompt: finish dependencies and docs

Copy everything below the line into a new session.

---

You are continuing work on MAP-IT-ALL, an open-source (MIT) local codebase map and MCP server for AI coding agents. Repository: https://github.com/peterish8/map-it-all. Work on the branch `feat/deps-and-docs` (already pushed). Goal: finish and prove two new features, `deps` (dependency advisories traced to your own files) and `docs` (version-pinned docs notes), without breaking the "offline by default" promise.

Do not rely on any earlier conversation. Read, in order:
1. `docs/handoffs/HANDOFF-2026-11-15-deps-and-docs.md` (everything: decisions, what exists, what is unverified, rules)
2. `SECURITY.md`, then the "Dependencies" section of `README.md`
3. `src/net.mjs`, `src/lock.mjs`, `src/extractors/deps.mjs`, `src/advisories.mjs`, `src/deps.mjs`, `src/docs.mjs`
4. `test/deps.test.mjs`

What the user approved: build both features as original code, keep the network off by default (only the user can enable it), credit the OSV data, commit to this branch on the GitHub remote. You may edit, test, commit and push on this branch. You may not merge to `main`, tag, publish to npm or the MCP registry, or force-push without asking the user.

Work order:
1. `git fetch && git switch feat/deps-and-docs && npm install && npm test` (41 tests should pass).
2. Run `node bin/map-it-all.mjs deps --online` against a real project that has a lockfile (the user will name one; if none, use `examples/demo-app` after adding a small `package.json` and lockfile in a temp copy). Fix any mismatch with the real OSV and registry responses. Add a trimmed real response as a test fixture. This sends only package names and versions.
3. Prove `docs <package> "<question>"` for one package with an `llms.txt` and one with only a GitHub README: it saves a pinned note, and a changed lockfile version flags it stale.
4. Add an MCP-level test for the `deps` tool (offline notice, `refresh` cannot enable the network, online path with the fake server).
5. Write `docs/deps.md`, make `doctor` show the network policy and cache age, keep the README token numbers equal to `map-it-all tokens`.
6. Open a PR into `main` ("feat: dependencies and version-pinned docs"), wait for CI, and report. Ask before merging.

Quality gates: `npm test` all green; before every push, grep the tree for local absolute paths, usernames, personal emails and private project names (ask the user for the terms; never write them into the repo); commits use the local git identity (a GitHub no-reply address; never a personal email) and end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; use the Edit tool for code changes; no secrets in files.

Open questions: ask the user once if something blocks you; otherwise use the defaults in section 12 of the handoff.

Report back to the user after steps 2 to 4: what changed, what you ran against the real services and what came back, test results, and anything you could not verify.
