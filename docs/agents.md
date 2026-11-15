# Connecting your agent

## Without cloning (npx)

```bash
claude mcp add map-it-all -- npx -y github:peterish8/map-it-all mcp           # macOS / Linux / WSL / Git Bash
```

```powershell
claude mcp add map-it-all '--' cmd /c npx -y github:peterish8/map-it-all mcp  # Windows PowerShell
```

**PowerShell note:** PowerShell swallows an unquoted `--` before `claude` sees it, so `claude mcp add map-it-all -- npx -y …` fails with `error: unknown option '-y'`. Quote it as `'--'` (tested), or avoid it entirely with `npx -y github:peterish8/map-it-all init --agent claude --npx --write`, which writes `.mcp.json` in your project. Claude Code asks you to approve a project-level server the first time it starts. Native Windows also needs `cmd /c` in front of `npx`.

`map-it-all init --npx` prints (or with `--write` merges) the same thing for Claude Code, Cursor, VS Code and Codex, with `cmd /c` added on Windows. The server maps the directory the client starts it in; pass `--root <dir>` or set `MAP_IT_ALL_ROOT` to point elsewhere. The config blocks below use a local clone instead (`node <MAP>/bin/map-it-all.mjs`), which is faster to start and works offline.

## With a local clone

`map-it-all init` prints each config below with your absolute paths filled in. `--write` merges it into the file for you (existing servers are kept) and adds `.map-it-all/` to `.gitignore`. Nothing else is ever edited.

Replace `<MAP>` with the path of this repo and `<PROJECT>` with the project you want mapped.

## Claude Code

`.mcp.json` in the project:

```json
{
  "mcpServers": {
    "map-it-all": {
      "command": "node",
      "args": ["<MAP>/bin/map-it-all.mjs", "mcp", "--root", "<PROJECT>"]
    }
  }
}
```

Start every session with the brief by adding a `SessionStart` hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node <MAP>/bin/map-it-all.mjs session-start --root <PROJECT>", "timeout": 120000 }] }
    ]
  }
}
```

The hook rebuilds the map only if HEAD or the working tree changed, saves the baseline that `diff` compares against, and prints the brief, which Claude Code adds to the session context.

## Cursor

`.cursor/mcp.json`: same `mcpServers` block as above.

## VS Code

`.vscode/mcp.json` uses `servers` instead of `mcpServers`:

```json
{ "servers": { "map-it-all": { "command": "node", "args": ["<MAP>/bin/map-it-all.mjs", "mcp", "--root", "<PROJECT>"] } } }
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.map-it-all]
command = "node"
args = ["<MAP>/bin/map-it-all.mjs", "mcp", "--root", "<PROJECT>"]
```

## Tell the agent how to use it

Add to `CLAUDE.md` / `AGENTS.md`:

```
- Start each session with the map-it-all `brief` tool. Before editing or deleting, use `connections` and `find`.
- Zero refs is a lead, never proof. `public` records may be used by installed clients: VERIFY, do not remove.
- Save durable learnings with the `memory` tool, anchored to files; call `handoff` before ending.
```

## Keep the tool surface small

Every connected tool is paid for on every request. `--profile minimal` exposes four tools (about 670 tokens); `standard` nine (about 1,150). Add it to the args: `"--profile", "minimal"`. Run `map-it-all tokens` to see the numbers for your install.

## Troubleshooting

- `map-it-all doctor` checks Node, git, ast-grep, Knip, RTK and the map.
- The server logs one line to stderr on start; stdout carries only protocol messages.
- First call in a session may take a few seconds while the map builds.
