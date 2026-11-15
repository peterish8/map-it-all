# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **One-command `init`**: builds the map and connections, writes the MCP config, appends an instruction block to the very end of `CLAUDE.md` and `AGENTS.md` (marker-delimited, idempotent, keeps line endings, same-file/symlink aware) and adds `.map-it-all/` to `.gitignore`. Flags: `--dry-run`, `--npx`, `--hook`, `--no-build`, `--no-docs`, `--docs claude|agents|both`, `--agent`, `--profile`. `init` now writes by default; `--write` is no longer needed.
- **`uninstall [--purge]`** removes exactly what `init` added. `--purge` deletes the map folder only when it lives inside the project.
- **Realtime mode** (off by default): `realtime on|off|status` on the CLI and as an MCP `realtime` tool, so an agent can toggle it. A `PostToolUse` edit hook (`touch`) schedules one coalesced, low-priority background rebuild per burst of edits and tells the agent, once and briefly, about public records, heavily imported files and newly orphaned records. No watcher or daemon.
- `init --hook` installs the SessionStart brief and the realtime edit hook, preserving your own hooks.

### Changed
- Faster builds: a 2,500-file monorepo went from about 11 s to about 4 to 5 s. Backtracking path regexes were replaced by linear tokenisation, npm-script references are found in one pass, and each file is stat'ed once.
- Map files are written atomically (stamp last) and readers wait for a build in progress, so a tool call never sees a half-written map.
- The MCP `standard` and `full` profiles include the `realtime` tool (about 1,270 and 1,400 tokens of definitions).

### Fixed
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
