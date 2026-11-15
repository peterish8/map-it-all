<p align="center">
  <img src="docs/assets/banner.svg" alt="MAP-IT-ALL: one local map of your codebase for AI coding agents" width="100%">
</p>

<p align="center">
  <a href="https://github.com/peterish8/map-it-all/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/peterish8/map-it-all/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node 20 or newer" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-8A2BE2">
  <img alt="One runtime dependency" src="https://img.shields.io/badge/runtime%20deps-1-brightgreen">
  <img alt="Network off by default" src="https://img.shields.io/badge/network-off%20by%20default-lightgrey">
</p>

<p align="center">
  <b>Your agent re-learns your repo every session, trusts notes the code has outgrown, and deletes things it cannot see are used.<br>MAP-IT-ALL fixes that, locally, in a few hundred tokens.</b>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#setup-by-operating-system">macOS · Windows · Linux</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#connect-your-agent">Connect your agent</a> ·
  <a href="#see-it-work">Example</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="docs/">Docs</a>
</p>

<p align="center">
  <img src="docs/assets/treemap-selected.png" alt="The zoomable map: every file is a box inside its folder, coloured by what the map found. A selected file shows its records, their flags, and the files that call them." width="100%">
  <br><sub>The bundled demo project. Red = no references, orange = verify, cyan outline = public surface. Click a file to see who calls it.</sub>
</p>

## Why

Solo developers working with coding agents keep hitting the same walls:

| The problem | What the research and reports say | What MAP-IT-ALL does |
| --- | --- | --- |
| Agents add code instead of changing it, break parts they cannot see, lose the plot in a large repo | [Columbia DAPLab's 9 failure patterns of coding agents](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html) (repeated code, codebase awareness, refactoring) | `connections` shows the blast radius before the edit; `find` and `symbol` find the helper that already exists |
| Every new session re-explains the project and burns input tokens | A constant complaint in developer threads; context files drift out of date | `brief` at session start, `handoff` at session end |
| Memory goes stale as the code changes | [STALE: can LLM agents know when their memories are outdated?](https://arxiv.org/abs/2605.06527), [Dosu on pruning stale agent memory](https://dosu.dev/articles/prune-stale-agent-memory) | Notes carry file hashes; `recall` flags `stale` and `orphaned` notes |
| Too many MCP tools cost tokens on every request and make tool choice worse | [MCP tool overload](https://dev.to/thedailyagent/mcp-tool-overload-why-more-tools-make-your-agent-worse-5a49) reports ~42,000 tokens of definitions for GitHub's official server | 4 to 13 tools in three profiles: **~668 / ~1,487 / ~1,611 tokens** (estimates; run `node bin/map-it-all.mjs tokens`) |
| Dead code piles up, docs describe deleted files | [Developers report](https://news.ycombinator.com/item?id=48770319) that agents add and rarely delete | `leads`, `diff`, and a docs-drift check |
| Shell output floods the context | [RTK](https://github.com/rtk-ai/rtk) | `doctor` detects it and prints the setup ([docs/rtk.md](docs/rtk.md)) |

## What you get

- **A session brief** (~450 tokens): git state, stack, layout, most-imported files, public surface, cleanup leads, your last handoff and memory notes. No more re-explaining the project.
- **Connections and blast radius.** Who imports this file, what it imports, and who calls the route or function it registers, including callers an import graph cannot see: `'module:fn'` strings, wrapper helpers, URL literals, Kotlin/JS native bridges.
- **Memory that knows when it is stale.** Notes are anchored to files by content hash. Change the file and the note is flagged before an agent trusts it.
- **Cleanup leads with the right amount of fear.** No references, test-only references, unmounted routes, unregistered native modules, tests no runner executes, docs pointing at deleted files. Anything an installed client or external caller could still reach is marked `public`: **VERIFY, never REMOVE**.
- **A session diff.** "What did this session just orphan?" in one call.
- **A zoomable map you can open** (the picture above).
- **Local and cheap.** No API keys, no telemetry, and the network is off unless you turn it on. OSV receives package/version queries and advisory IDs in detail URLs; npm and docs hosts receive their requested URLs, remote IP and ordinary HTTP/TLS metadata, including the user-agent. Network metadata may reveal package or repository names. One runtime dependency, [ast-grep](https://ast-grep.github.io). Works with any MCP client: Claude Code, Cursor, VS Code, Codex.

It does **not** replace a language server or a call-graph tool. For exact, type-aware call graphs, run one next to it (graft, [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), Serena, CodeGraph). MAP-IT-ALL covers what those do not: registration and liveness facts, session memory and the brief. See the [comparison](#how-it-compares).

## Quickstart

Works the same on **macOS, Windows and Linux** (including WSL). You need Node 20 or newer and git; the three commands below are identical on every OS and in every shell. Where the OSes differ (installing Node, registering the server by hand, troubleshooting) there is a [per-OS guide](#setup-by-operating-system) right after.

**0. Check the prerequisites:**

```bash
node -v      # v20 or higher
git --version
```

Missing one? Jump to [your OS](#setup-by-operating-system) for the install line.

**1. See it first (10 seconds, touches nothing of yours):**

```bash
npx -y github:peterish8/map-it-all demo --open
```

That maps a bundled sample project into your temp folder and opens the zoomable map.

**2. Set it up in your project, with one command** (run it from your project folder):

```bash
npx -y github:peterish8/map-it-all init --npx
```

That works in bash, zsh, fish, PowerShell and cmd alike (on Windows it writes the `cmd /c npx` form the MCP config needs), and it does everything:

```text
[1/4] Map             built in 0.6 s: 46 files, packs: convex, express, expo
                      connections: 16 import edges across 14 imported files; most imported: web/src/lib/api.ts (x3)
                      19 public records (verify, never remove), 15 cleanup leads
[2/4] MCP config      claude: added in .mcp.json
[3/4] Instructions    CLAUDE.md: appended; AGENTS.md: created
[4/4] .gitignore      .map-it-all/ added
```

1. **Builds the map and the connections** (import graph, who calls what, public surface).
2. **Writes the MCP config** for your agent (`--agent claude|cursor|vscode|codex|all`, default Claude Code), merging with servers you already have.
3. **Appends three lines to the very end of `CLAUDE.md` and `AGENTS.md`**, between `<!-- map-it-all:start -->` and `<!-- map-it-all:end -->` markers. Your own text is never touched, a second run changes nothing, and `uninstall` removes exactly that block.
4. **Adds `.map-it-all/` to `.gitignore`.**

Preview it first with `--dry-run`. Add `--hook` to also install the Claude Code hooks (a session-start brief and [realtime](#realtime-mode)). Use `--no-docs` to leave `CLAUDE.md`/`AGENTS.md` alone.

**3. Restart your agent and ask it to "call the map-it-all `brief` tool".** Claude Code asks you to approve a project-level server once. Check with `claude mcp list`, or run `npx -y github:peterish8/map-it-all doctor`.

Prefer to register the server yourself, or not on Claude Code? The per-OS commands are in the next section, and [Connect your agent](#connect-your-agent) covers Cursor, VS Code and Codex.

## Setup by operating system

Pick your OS. Each one has the same four parts: install the prerequisites, run `init`, register by hand if you prefer, and fix the usual problems.

<details open>
<summary><b>macOS</b> (Terminal, iTerm, zsh or bash)</summary>

**Install Node and git** with [Homebrew](https://brew.sh):

```bash
brew install node git
node -v && git --version
```

No Homebrew? Download the LTS installer from [nodejs.org](https://nodejs.org), and run `xcode-select --install` for git.

**Set up, from your project folder:**

```bash
cd ~/code/my-project
npx -y github:peterish8/map-it-all init --npx
```

**Register by hand (Claude Code):**

```bash
claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp
claude mcp list                                   # map-it-all should be listed
npx -y github:peterish8/map-it-all doctor         # checks Node, git, ast-grep, the map
```

**Open the map:** `npx -y github:peterish8/map-it-all view --open`

**Good to know:** if `node` or `npx` is "command not found" right after installing, open a new terminal tab. On Apple Silicon, Homebrew lives in `/opt/homebrew`; if `brew` itself is not found, run `eval "$(/opt/homebrew/bin/brew shellenv)"` and add that line to `~/.zprofile`.
</details>

<details>
<summary><b>Windows</b> (PowerShell, Windows Terminal, cmd, Git Bash)</summary>

**Install Node and git** with winget (built into Windows 10 and 11), then **open a new terminal** so `PATH` refreshes:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
node -v; git --version
```

No winget? Use the installers from [nodejs.org](https://nodejs.org) and [git-scm.com](https://git-scm.com).

**Set up, from your project folder** (same line in PowerShell, cmd and Git Bash):

```powershell
cd C:\code\my-project
npx -y github:peterish8/map-it-all init --npx
```

`init` writes the Windows form of the MCP entry for you (`cmd /c npx ...`), because Windows cannot launch `npx` directly from an MCP config.

**Register by hand (Claude Code).** The shell matters here:

```powershell
# PowerShell: quote the double dash (PowerShell swallows a bare --) and go through cmd
claude mcp add map-it-all '--' cmd /c npx -y github:peterish8/map-it-all mcp
```

```bat
:: cmd.exe
claude mcp add map-it-all -- cmd /c npx -y github:peterish8/map-it-all mcp
```

```bash
# Git Bash or WSL: the macOS/Linux form
claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp
```

Then `claude mcp list` and `npx -y github:peterish8/map-it-all doctor`.

**Open the map:** `npx -y github:peterish8/map-it-all view --open`

**Good to know:**

- `error: unknown option '-y'` means PowerShell ate the `--`. Use the quoted `'--'` above, or sidestep the problem with `npx -y github:peterish8/map-it-all init --agent claude --npx`.
- `npx.ps1 cannot be loaded because running scripts is disabled`: run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or call `npx.cmd` instead of `npx`.
- Cursor and VS Code configs on Windows use `"command": "cmd", "args": ["/c", "npx", ...]`; `init --agent cursor` or `--agent vscode` writes that for you.
- Project-scope servers need a one-time approval inside Claude Code (see step 3).
- Prefer Linux tooling? Everything in the **Linux** section works inside WSL. Install Node inside WSL too: `which node` must not point at `/mnt/c/...`.
</details>

<details>
<summary><b>Linux</b> (Ubuntu, Debian, Fedora, Arch and others, bash, zsh or fish; also WSL)</summary>

**Install Node 20+ and git.** Distro packages are sometimes older than Node 20, so check `node -v` after installing. If it is too old, use [nvm](https://github.com/nvm-sh/nvm) (follow the install line in its README), which needs no root:

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y git curl
# Fedora / RHEL
sudo dnf install -y git nodejs npm
# Arch
sudo pacman -S git nodejs npm

# any distro, if node is older than v20: install nvm (see its README), then
nvm install --lts
node -v && git --version
```

**Set up, from your project folder:**

```bash
cd ~/code/my-project
npx -y github:peterish8/map-it-all init --npx
```

**Register by hand (Claude Code):**

```bash
claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp
claude mcp list
npx -y github:peterish8/map-it-all doctor
```

**Open the map:** `npx -y github:peterish8/map-it-all view --open` uses `xdg-open`. On a server, over SSH or in a container there is no browser, so run `view` without `--open`: it prints the path of `graph.html` to copy to a machine that has one. On WSL, open the file from Windows Explorer (`explorer.exe .` in the folder).

**Good to know:**

- With `nvm`, make sure the shell that launches your agent loads it (it must see the same `node` as your terminal). If an editor starts the MCP server and fails with `npx: not found`, put the absolute path from `which npx` in the config's `command` field.
- `npx` needs git to fetch `github:` packages; install it if you see `spawn git ENOENT`.
- Behind a proxy or offline? Use the [local clone](#prefer-a-local-clone) below, which needs the network only for `npm install`.
</details>

### Same thing, side by side

| | macOS / Linux / WSL / Git Bash | Windows PowerShell | Windows cmd |
| --- | --- | --- | --- |
| Set up | `npx -y github:peterish8/map-it-all init --npx` | same | same |
| Register (Claude Code) | `claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp` | `claude mcp add map-it-all '--' cmd /c npx -y github:peterish8/map-it-all mcp` | `claude mcp add map-it-all -- cmd /c npx -y github:peterish8/map-it-all mcp` |
| Verify | `claude mcp list` and `... doctor` | same | same |
| Realtime on / off | `npx -y github:peterish8/map-it-all realtime on` | same | same |
| Open the map | `... view --open` (`open` on macOS, `xdg-open` on Linux) | `... view --open` | `... view --open` |
| Remove | `... uninstall` (add `--purge` to delete `.map-it-all/`) | same | same |

(`...` stands for `npx -y github:peterish8/map-it-all`.)

### Update, pin, undo

Same on every OS:

```bash
npx -y github:peterish8/map-it-all#v0.1.0 init --npx   # pin a release instead of tracking main
npx -y github:peterish8/map-it-all uninstall           # remove the block, MCP entry and hooks; keeps your memory notes
npx -y github:peterish8/map-it-all uninstall --purge   # also delete .map-it-all/ (only ever inside your project)
```

`npx` caches what it fetches, so a newer `main` may not be picked up right away. Pin a tag (above) for a predictable version, or delete the `_npx` folder inside the directory printed by `npm config get cache` to force a fresh download.

**Working with teammates on other operating systems?** `init --npx` writes the MCP entry for the OS it runs on (`cmd /c npx` on Windows, plain `npx` elsewhere), so a committed `.mcp.json` from one OS will not start on the other. Either have each person run `init` locally and leave `.mcp.json` uncommitted, or commit one OS's file and let the others re-run `init`.

### Prefer a local clone?

```bash
git clone https://github.com/peterish8/map-it-all.git
cd map-it-all && npm install            # installs ast-grep, the only dependency
```

Then, from your project folder, call the script by its path:

```bash
# macOS / Linux / WSL
node ~/code/map-it-all/bin/map-it-all.mjs doctor
node ~/code/map-it-all/bin/map-it-all.mjs init      # the MCP entry points at your clone
node ~/code/map-it-all/bin/map-it-all.mjs view --open
```

```powershell
# Windows PowerShell
node C:\code\map-it-all\bin\map-it-all.mjs doctor
node C:\code\map-it-all\bin\map-it-all.mjs init
node C:\code\map-it-all\bin\map-it-all.mjs view --open
```

## Realtime mode

Optional, **off by default**, and switchable at any time, by you or by the agent.

```bash
map-it-all realtime on        # or: off | status
```

An agent can also call the `realtime` tool (`action: on|off|status`) when it wants the map kept current during a long edit session and switch it off again afterwards. It needs the edit hook, which `init --hook` installs.

How it stays cheap:

- **No watcher, no daemon.** A `PostToolUse` hook fires only when the agent edits a file. While realtime is off the hook exits after one file check.
- **One rebuild per burst.** Edits are coalesced: a detached, below-normal-priority worker waits for a quiet moment (about 1.5 s, at most 8 s), then rebuilds once. Many edits cost one build.
- **Never blocks an edit.** The hook returns in about 0.2 s (mostly Node start-up), always exits 0, and has a 10 s timeout.
- **Quiet by design.** After an edit the agent hears something only if it matters: the file holds `public` records, many files import it, or a recent edit left something with no references. Each warning is delivered once, in under 560 characters.
- **Safe reads.** Map files are written atomically and readers wait for a rebuild in progress, so a tool call never sees a half-written map.

On a 2,500-file monorepo a background rebuild takes about 5 seconds of one low-priority core, roughly 7 seconds after the last edit of a burst.

## Connect your agent

`map-it-all init --agent <claude|cursor|vscode|codex|all> [--npx]` writes the right config for your OS and keeps any servers you already have (`--dry-run` previews). By hand:

<details open>
<summary><b>Claude Code</b></summary>

```bash
# macOS / Linux / WSL / Git Bash, from your project folder
claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp

# Windows PowerShell: npx runs through cmd, and the double dash must be quoted
claude mcp add map-it-all '--' cmd /c npx -y github:peterish8/map-it-all mcp

# any shell, no `--` to get wrong: the tool writes .mcp.json for you
npx -y github:peterish8/map-it-all init --agent claude --npx
```

`init --hook` adds a `SessionStart` hook to `.claude/settings.json` (and the realtime edit hook). The session hook rebuilds only if HEAD or the working tree changed, saves the baseline that `diff` compares against, and prints the brief, which Claude Code adds to the session. By hand it is:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "npx -y github:peterish8/map-it-all session-start", "timeout": 120000 }] }
    ]
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "map-it-all": { "command": "npx", "args": ["-y", "github:peterish8/map-it-all", "mcp"] }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json` (note `servers`, not `mcpServers`):

```json
{
  "servers": {
    "map-it-all": { "command": "npx", "args": ["-y", "github:peterish8/map-it-all", "mcp", "--root", "${workspaceFolder}"] }
  }
}
```
</details>

<details>
<summary><b>Codex</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.map-it-all]
command = "npx"
args = ["-y", "github:peterish8/map-it-all", "mcp", "--root", "/absolute/path/to/your/project"]
```
</details>

By default the server maps the directory the client starts it in. Use `--root <dir>` or `MAP_IT_ALL_ROOT` to point elsewhere. Add `--profile minimal` to expose four tools (about 668 estimated tokens of definitions) instead of eleven. More in [docs/agents.md](docs/agents.md).

`init` writes these three lines to the end of your `CLAUDE.md` / `AGENTS.md` for you ([snippet](examples/CLAUDE.md.snippet) if you prefer to paste them):

```markdown
- Start each session with the map-it-all `brief` tool. Before editing or deleting, use `connections` and `find`.
- Zero refs is a lead, never proof. `public` records may be used by installed clients: VERIFY, do not remove.
- Save durable learnings with the `memory` tool, anchored to files; call `handoff` before ending.
```

## See it work

Real output from the bundled demo project (`map-it-all demo`).

**`brief`**: what an agent needs to start, in ~450 tokens.

```text
# Session brief: demo-app

Stack: convex: 9 functions (7 public), 4 tables · express: 11 routes (2 conditional) · expo/android: 2 screens, 2 native modules, 3 kotlin classes
Layout:
  web  11 files (tsx/ts)
  convex  10 files (ts)
  mobile  8 files (kt/tsx)
  server  7 files (ts)
Most-imported files (change with care):
  web/src/lib/api.ts  ×2
Public surface (installed clients may still call it: VERIFY before removing): 7 convex-function, 1 convex-http, 11 express-route
Cleanup leads: 5 express-route, 3 convex-function, 2 kotlin-class, 2 npm-script, 2 test-file, 2 env-var
Docs pointing at missing paths: 1 doc(s); worst README.md (2). Do not trust those docs' file references.
```

**`leads`**: what looks unused, and what needs care.

```text
convex-function (3)
  convex:streaks.forHabit   convex/streaks.ts:4         [no-refs] public
  convex:habits.archive     convex/habits.ts:8          [no-refs] public
  convex:legacyImport.run   convex/legacyImport.ts:4    [test-only] public
native-module (1)
  native-module:HabitWidget mobile/android/.../HabitWidgetModule.kt:2  [not-in-ExpoModulesPackageList]
express-route (5)
  express:GET /api/admin/users   server/routes/admin.ts:4   [conditional-mount,no-refs,undocumented] public
  express:GET /api/stats/export  server/routes/stats.ts:4   [no-refs,undocumented] public
```

**`connections`**: the blast radius, with the warning an agent needs.

```text
$ map-it-all connections convex:habits.archive
No by-name callers recorded for convex:habits.archive [no-refs] public: installed or external clients may still call it

$ map-it-all connections web/src/lib/api.ts --direction in
IN: depends on this file (blast radius) (3)
  d1  web/src/hooks/useHabits.ts:2
  d1  web/src/lib/api.test.ts:1 [test]
  d1  web/src/pages/Settings.tsx:1
```

**`memory recall`**: a note that notices the code moved.

```text
health-route-stays-above-the-routers-3fdf2  [decision] STALE
  Health route stays above the routers
  Load balancers hit /health before auth is mounted.
  anchors: server/app.ts
  ! server/app.ts changed since this note was written: verify before relying on it
```

## The loop

1. **Start:** the `SessionStart` hook (or the agent) calls `brief`.
2. **Before editing or deleting:** `connections` and `find`. `public` means installed clients or external callers: VERIFY.
3. **While working:** `memory` → `remember` for a decision or a gotcha, anchored to the files it is about.
4. **After a change:** `diff` lists records that just lost their last production reference.
5. **End:** `handoff` → `save` with a summary and next steps. The next brief shows it, and flags files that changed since.

## Tools

| Tool | What it answers |
| --- | --- |
| `brief` | What do I need to know to start? |
| `find` | Which routes, functions, native modules, scripts or docs match this? Filter by flag or public surface. |
| `file` | Everything about one file: records, importers, imports, debt, anchored notes |
| `connections` | Who depends on this, what does it depend on, who calls what it registers? (`format: "mermaid"` draws it) |
| `leads` | What looks unused or broken, and what needs VERIFY? |
| `symbol` | Where is this name declared and mentioned? (name-based, not type-aware) |
| `diff` | What did this session newly orphan? |
| `deps` | Which files import each package, which installed versions are vulnerable or deprecated and which of my files they expose, what is possibly unused. `package` + `docs` saves a version-pinned docs note. Online lookups only if you enabled them. |
| `memory` | `remember`, `recall`, `confirm`, `forget`, `list`: notes anchored to files |
| `handoff` | `save` at the end, `read` at the start |
| `realtime` | Turn the [realtime refresh](#realtime-mode) on, off, or read its status |
| `refresh`, `view` | Rebuild now (optionally with Knip); path of the zoomable map |

Profiles (`--profile`): `minimal` is brief, find, connections, memory; `standard` (default) adds file, leads, symbol, diff, deps, handoff, realtime; `full` adds refresh and view. Every tool is also a CLI command, so the terminal and the agent always agree.

## CLI

```text
map-it-all demo [--open]                try it on a bundled sample, touching nothing of yours
map-it-all init [--npx] [--hook] [--dry-run]   map + MCP config + CLAUDE.md/AGENTS.md block + .gitignore
map-it-all uninstall [--purge]          remove what init added (keeps memory unless --purge)
map-it-all realtime [on|off|status]     keep the map fresh as the agent edits (needs init --hook)
map-it-all doctor                       check Node, git, ast-grep, Knip, RTK, the map
map-it-all build [--with-knip]          build the map (about 5 s on 2,500 files, under 1 s on small repos)
map-it-all view [--open]                the zoomable map page
map-it-all brief | session-start        the session brief | rebuild, snapshot, brief (a hook)
map-it-all query <text> [--kind k] [--flag f]
map-it-all file <path> | connections <target> [--direction in|out|both] [--depth n] [--mermaid]
map-it-all leads [--kind k] [--flag f] [--public] | symbol <name> | diff
map-it-all memory list|recall <q>|forget <id> | handoff | tokens
map-it-all check                        exit 1 if a pack's rules drifted (for CI)
map-it-all mcp [--profile minimal|standard|full]
```

`map-it-all <command> --help` for one command. Run `map-it-all tokens` to see what the MCP tool definitions cost on your install.

## Dependencies

`map-it-all deps` (and the `deps` MCP tool) ties your dependencies to your code: which files import each package, and, if you allow online lookups, which installed versions have known vulnerabilities or are deprecated, **and which of your files are exposed** (a vulnerable transitive package is traced back to the direct dependency that pulls it in, and from there to the files that import it).

```text
$ map-it-all deps --online
Dependencies: 38 direct (27 prod, 11 dev), 612 installed copies in package-lock.json
Advisories: 2 vulnerable package version(s), 1 deprecated direct dependency version(s); checked 3 min ago

CRITICAL inner@1.0.0  [via lodash]
  GHSA-bbbb: Remote code execution
  exposed in 2 file(s): src/a.ts:1, src/b.ts:1
```

- **Offline by default.** The build only records versions (from `package-lock.json`, `yarn.lock` classic or `pnpm-lock.yaml`) and who imports what. Advisories and deprecations come from [OSV.dev](https://osv.dev) and the npm registry, only when **you** allow it: `--online` for one run, `"network": true` in `map-it-all.config.json`, or `MAP_IT_ALL_ONLINE=1`. An agent cannot switch it on; `MAP_IT_ALL_OFFLINE=1` forces it off.
- **What is sent:** OSV receives package/version query bodies and advisory IDs in detail URL paths. npm and docs hosts receive requested URLs, your remote IP, and ordinary HTTP/TLS metadata including the user-agent; that metadata may reveal package or repository names. The application payloads (bodies and URLs) carry only package names and versions, advisory ids and the docs addresses the registry returned: no source, file paths or account details. Network-level visibility is separate: remote services and the network path still see your IP, the host names, timing and the user-agent. Answers are cached in `.map-it-all/deps-cache.json`: while entries are fresh (24 hours for advisory lookups, 7 days for details and registry data), an unchanged lockfile costs no requests. One lookup can mean several requests.
- **Docs notes:** `map-it-all docs <package> "how do I debounce"` prints the same package view as `deps <package>` (versions, importers, advisories, deprecation, OSV credit when advisories appear) and then the saved note: a short excerpt from the package's `llms.txt`, else its GitHub README. Online, that means OSV and registry requests as well as the docs requests. Selection uses shallow question-term/token matching, not semantic answering. The source is current at fetch time; compatibility with the installed package version is unverified. The version pin is only a local invalidation anchor, so a version change marks the note stale but does not verify source compatibility. `memory list` reads the saved map without rebuilding it, so it shows that staleness only after a command that rebuilds the map (`build`, `deps`, `docs`, or the session hook).
- **CLI output:** the complete command prints package details plus advisory findings and the OSV/credit block when applicable; the abbreviated example above shows only the summary shape.
- Remote text is treated as untrusted: cleaned, size-capped, and docs links may only reach public https hosts. Advisory data: OSV.dev (GitHub Advisory Database, CC BY 4.0).
- `map-it-all init --online` saves the opt-in as `"network": true`; plain `init` stays offline. `map-it-all doctor` shows the effective network policy and the age of the advisory cache.

Full details (precedence, what is sent, caches, partial results, supported lockfiles and attribution limits, docs sources): [docs/deps.md](docs/deps.md).

## What gets mapped

**Generic, any JS/TS repo:** an import graph with real alias resolution (tsconfig `paths` and `extends`, workspace packages), docs and their inbound links, **docs drift** (docs naming files that no longer exist; fenced examples skipped), debt markers, npm scripts and script files nothing references, **tests outside every runner glob**, env vars read but set nowhere in the checkout, web workers.

**Framework packs, auto-detected:**

| Pack | Detected from | Maps |
| --- | --- | --- |
| **convex** | a `convex/` folder with `schema.ts` | functions and every caller form (`api.x.y`, `internal.x.y`, `anyApi`, `'module:fn'` strings, `` `module:${name}` `` wrappers, crons, runbook mentions), tables with reads and writes, HTTP routes |
| **express** | files that call `express()` | routes with full mount paths (nested, default-export, factory and same-file routers, conditional mounts), URL callers across the repo, whether a doc mentions the route |
| **expo** | a `package.json` with `expo` or `react-native` next to a Kotlin `android/` folder | screens, native modules (Kotlin `Name("X")` against JS callers against the package list), Kotlin classes |

Details, limits and how to write a pack: [docs/packs.md](docs/packs.md).

## Memory that knows when it is stale

```text
memory remember  title:   "Health route stays above the routers"
                 body:    "Load balancers hit /health before auth is mounted."
                 kind:    decision
                 anchors: ["server/app.ts"]
```

`recall` re-hashes every anchor against the working tree: `fresh`, `stale` (an anchored file changed) or `orphaned` (it is gone). `confirm` re-verifies after the agent checked. Notes are small JSON files under `.map-it-all/memory/`; set `memoryDir` to commit them and share with a team. [docs/memory.md](docs/memory.md)

## How it works

```mermaid
flowchart LR
  A[Your working tree<br/>git + files] --> B[ast-grep rules<br/>+ regex + import graph]
  B --> C[.map-it-all/<br/>JSON records]
  C --> D[MCP server<br/>stdio, local]
  C --> E[CLI]
  C --> F[Zoomable map<br/>graph.html]
  G[Memory notes<br/>+ handoff] --> D
  D --> H[Claude Code · Cursor<br/>VS Code · Codex]
```

Code structure comes from [ast-grep](https://ast-grep.github.io) rules (tree-sitter, so comments and strings never cause false hits). A pack only reports what a plain regex count also sees: `map-it-all check` compares them and exits 1 on drift, so a rule that stops matching is loud. Everything is plain JSON and Markdown you can read.

## Pair with RTK

MAP-IT-ALL shrinks what an agent has to *read about your code*. [RTK](https://github.com/rtk-ai/rtk) shrinks what comes back from the *commands it runs*. They do not overlap and neither needs the other. `map-it-all doctor` detects it and prints the install line for your OS ([docs/rtk.md](docs/rtk.md)).

## Configuration

Zero config works. To override detection, add `map-it-all.config.json` at the repo root:

```json
{
  "historyDirs": [".planning", "archive"],
  "ignore": ["**/vendor/**"],
  "driftIgnore": ["^\\.mcp\\.json$"],
  "network": false,
  "convex": { "dir": "convex" },
  "express": { "appFiles": ["server/app.ts"] },
  "expo": { "dir": "apps/mobile" }
}
```

[Every option](docs/packs.md) · [example file](examples/map-it-all.config.example.json)

## How it compares

|  | MAP-IT-ALL | Call-graph servers (graft, codebase-memory-mcp, CodeGraph, Serena) | General agent-memory services (Mem0, Zep, Letta, Cognee) | RTK |
| --- | --- | --- | --- | --- |
| Answers | What registers, references and imports what; what is safe to touch; where we left off | Exact symbol-level callers and definitions | What was said or decided across conversations | Shorter command output |
| Memory is tied to code | Yes, by file hash; flags stale | Not their focus | Not by file hash, typically | No |
| Marks what shipped clients may still call (VERIFY, not REMOVE) | Yes (`public`) | Not their focus | Not their focus | No |
| Needs a model, vector store or API key | No | No | Typically yes | No |
| Tool-definition cost | ~668 to ~1,611 estimated tokens | Varies by server | Varies | n/a (CLI hook) |

They are complements: run a call-graph server for exact call graphs, MAP-IT-ALL for the brief, registration facts and memory, RTK for shell output.

## FAQ

<details>
<summary><b>Does it send my code anywhere?</b></summary>
No. By default it makes no network requests and has no telemetry. It reads your project folder, runs <code>git</code> and ast-grep locally, and writes to <code>.map-it-all/</code>. The opt-in <a href="#dependencies">dependency lookups</a> send package/version queries and advisory IDs to OSV, plus requested URLs and ordinary connection metadata to npm and docs hosts; that metadata may reveal package or repository names. See <a href="SECURITY.md">SECURITY.md</a>.
</details>

<details>
<summary><b>"No references" means I can delete it, right?</b></summary>
No, and the tool is built to say so. Zero refs is a lead. Routes, public Convex functions and similar are marked <code>public</code> because installed mobile builds, desktop apps and outside callers may still use them; no caller in the repo means VERIFY. A static map cannot see strings built at runtime or callers outside the repo.
</details>

<details>
<summary><b>Does it replace graft, codebase-memory-mcp or a language server?</b></summary>
No. Those give exact, type-aware call graphs. MAP-IT-ALL gives registration and liveness facts, the session brief and anchored memory, and its <code>symbol</code> tool is name-based. Use them together.
</details>

<details>
<summary><b>How big a repo can it handle, and how slow is it?</b></summary>
On a real 2,500-file TypeScript/Kotlin monorepo (Convex, Express, Expo) a full build takes about 4 to 5 seconds (7 to 11 in v0.1.0), a small repo under a second, and parity checks pass (Convex 134/134 functions, Express 93/93 routes). Reads check freshness in well under a second and rebuild only when HEAD or the working tree changed. With [realtime](#realtime-mode) on, a background rebuild runs once per burst of edits, at low priority.
</details>

<details>
<summary><b>My stack is not Convex, Express or Expo.</b></summary>
You still get the import graph, docs links and drift, scripts, tests outside runners, env vars, debt and the brief, memory and handoff. Framework packs are small; see <a href="docs/packs.md#writing-a-new-pack">writing a new pack</a> or open a <a href="https://github.com/peterish8/map-it-all/issues/new?template=feature_request.yml">framework request</a> with a snippet of how routes are registered.
</details>

<details>
<summary><b>Why not a vector database for memory?</b></summary>
Project memory asks "what did we decide about this file, and is that still true?" Anchors plus text search answer both with nothing to host and every note readable by a human. See <a href="docs/memory.md">docs/memory.md</a>.
</details>

<details>
<summary><b>Where do the map, notes and handoff live?</b></summary>
In <code>.map-it-all/</code> in your project (gitignored by <code>init</code>). Set <code>memoryDir</code> to keep notes somewhere tracked.
</details>

<details>
<summary><b>Windows?</b></summary>
Yes. It was built and tested on Windows, and CI runs on Windows and Linux. For MCP clients, run <code>npx</code> through <code>cmd /c</code>; <code>init --npx</code> writes that for you.
</details>

## Roadmap

Ideas, not promises. Open an issue to vote or to propose.

- More packs: Next.js route handlers, Hono/Fastify, NestJS, tRPC
- Convex nested module folders
- Optional import of SCIP indexes for exact call edges
- A per-file incremental build for very large repos (today realtime rebuilds the whole map once per burst)
- Publish to npm and the MCP registry

## Contributing

Issues and pull requests are welcome, especially **a wrong or missing result with a small project that shows it**. See [CONTRIBUTING.md](CONTRIBUTING.md); please read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately ([SECURITY.md](SECURITY.md)).

```bash
git clone https://github.com/peterish8/map-it-all.git && cd map-it-all
npm install && npm test       # 46 tests: packs, import resolution, memory, MCP protocol, CLI, init, realtime, dependencies
```

## Acknowledgements

Built on [ast-grep](https://ast-grep.github.io) (code structure) and informed by [Knip](https://knip.dev) (unused files and exports, an optional bridge), [RTK](https://github.com/rtk-ai/rtk) (command-output compression), and the research and reports linked above.

## License

[MIT](LICENSE)
