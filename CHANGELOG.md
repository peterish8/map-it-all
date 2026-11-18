# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **One-command `init`**: builds the map and connections, writes the MCP config, appends an instruction block to the very end of `CLAUDE.md` and `AGENTS.md` (marker-delimited, idempotent, keeps line endings, same-file/symlink aware) and adds `.map-it-all/` to `.gitignore`. Flags: `--dry-run`, `--npx`, `--hook`, `--no-build`, `--no-docs`, `--docs claude|agents|both`, `--agent`, `--profile`. `init` now writes by default; `--write` is no longer needed.
- **`uninstall [--purge]`** removes exactly what `init` added. `--purge` deletes the map folder only when it lives inside the project.
- **Realtime mode** (off by default): `realtime on|off|status` on the CLI and as an MCP `realtime` tool, so an agent can toggle it. A `PostToolUse` edit hook (`touch`) schedules one coalesced, low-priority background rebuild per burst of edits and tells the agent, once and briefly, about public records, heavily imported files and newly orphaned records. No watcher or daemon.
- `init --hook` installs the SessionStart brief and the realtime edit hook, preserving your own hooks.

- **Dependencies** (`deps` tool and CLI command, `docs` command): every declared package is a map record joined to the files that import it, with versions from `package-lock.json`, `yarn.lock` (classic) or `pnpm-lock.yaml`. With online lookups enabled by the user (`--online`, `"network": true` or `MAP_IT_ALL_ONLINE=1`; an agent cannot enable them), advisories from OSV.dev and deprecations from the npm registry are traced from transitive packages back to your direct dependencies and the files that import them, cached by name and version. `docs` saves a version-pinned excerpt (`llms.txt`, else the GitHub README) as a memory note that flags itself stale when the version changes (new `pins` on memory notes). The session brief gets one dependency line from the cache. Unused production dependencies are listed as leads. Details in [docs/deps.md](docs/deps.md).
- `init --online` saves `"network": true` in `map-it-all.config.json` (plain `init` stays offline), and `doctor` shows the effective network policy and the age of the advisory cache.

### Changed
- The `standard` and `full` MCP profiles add the `deps` tool (about 1,490 and 1,610 tokens of definitions). The network is now "off by default" instead of "never".
- Faster builds: a 2,500-file monorepo went from about 11 s to about 4 to 5 s. Backtracking path regexes were replaced by linear tokenisation, npm-script references are found in one pass, and each file is stat'ed once.
- Map files are written atomically (stamp last) and readers wait for a build in progress, so a tool call never sees a half-written map.
- The MCP `standard` and `full` profiles include the `realtime` tool (about 1,270 and 1,400 tokens of definitions).
- CI runs install, `npm test`, `check` and `doctor` on Node 20 and Node 22, on Ubuntu and Windows. Job names now include the Node version, so any branch rule that names the old job must be updated. `npm test` runs its test files through `scripts/run-tests.mjs`: on Node 20 the previous quoted glob made `npm test` exit with "Could not find" and run no tests, because Node 20 does not expand that glob.

### Fixed
- Paths from agents: memory anchors and handoff files that are absolute, drive-relative, UNC, device, NTFS-stream or NUL-containing paths, or that leave the project with `..`, are refused with the usual "not a file in this project" message, and an existing file outside the project is no longer accepted. A stored anchor that leaves the project loads as missing, so older notes still load.
- The scanner no longer reads a file through a symlink or Windows junction that resolves outside the project. Such files are left out of the map, and the map's generator notes say how many were skipped.
- MCP `tools/call` checks arguments against each tool's declared schema (types, enums, required fields, ranges). A bad call returns JSON-RPC `-32602` naming the tool and field, and the tool does not run. Unknown properties are ignored, and `null` counts as absent. Tool definitions are unchanged.
- MCP `initialize` answers with a supported protocol version (`2025-06-18`, `2025-03-26` or `2024-11-05`) instead of echoing whatever the client sent; an unsupported request gets the newest supported version.
- Docs: a per-OS setup guide for macOS, Windows (PowerShell, cmd, Git Bash) and Linux/WSL: installing Node and git, the right `claude mcp add` form for each shell, opening the map, and the usual PATH, execution-policy and cross-OS `.mcp.json` pitfalls.
- Docs: the Claude Code one-liner failed in Windows PowerShell with `unknown option '-y'` because PowerShell swallows an unquoted `--`. The README and `docs/agents.md` now show the PowerShell form (`'--'`) and a shell-independent alternative (`init --agent claude --npx`).

## [0.1.0] - 2026-11-15

First public release.

### Added
- **MCP server** over stdio with three profiles (`minimal`, `standard`, `full`; about 670, 1,150 and 1,270 tokens of tool definitions): `brief`, `find`, `file`, `connections`, `leads`, `symbol`, `diff`, `memory`, `handoff`, `refresh`, `view`.
- **Session brief**: git state, stack, layout, most-imported files, public surface, cleanup leads, last handoff and memory notes, in a few hundred tokens.
- **File-anchored memory** that flags notes as `stale` or `orphaned` when the files they are about change or disappear, plus a session `handoff`.
- **Framework packs**, auto-detected: Convex, Express (nested, default-export, factory, same-file and conditional mounts), Expo/React Native with Kotlin native modules.
- **Generic checks**: import graph with tsconfig `paths` and workspace resolution, docs inbound links, docs drift (docs naming deleted files), tests outside every runner, env vars read but never set, scripts, workers, debt markers, optional Knip.
- **Zoomable treemap** (`view`): every file as a box, coloured by findings, with importers, imports and callers drawn for a selected file.
- **CLI**: `demo`, `init` (prints or writes MCP config for Claude Code, Cursor, VS Code, Codex; `--npx` mode), `doctor` (including RTK detection), `build`, `view`, `brief`, `query`, `file`, `connections`, `leads`, `symbol`, `diff`, `check`, `session-start`, `snapshot`, `ensure`, `memory`, `handoff`, `tokens`, `mcp`.
- A bundled demo project (`examples/demo-app`) with deliberately planted problems.

[0.1.0]: https://github.com/peterish8/map-it-all/releases/tag/v0.1.0
