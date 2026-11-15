# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

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
