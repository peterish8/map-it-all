# Pair with RTK (shell-output compression)

MAP-IT-ALL shrinks what an agent has to *read about your code*. [RTK](https://github.com/rtk-ai/rtk) shrinks what comes back from the *commands the agent runs* (test runs, `git`, installs). They do not overlap, and neither needs the other.

What follows is taken from RTK's README (checked 2026-11-15). Re-check there before relying on it: it is another project and may change.

## Install

| Platform | Command |
| --- | --- |
| Windows | `winget install rtk-ai.rtk` |
| macOS, or Linux with Homebrew | `brew install rtk` |
| Linux, macOS, WSL | `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh \| sh` |

## Hook it into your agent

```bash
rtk init -g      # installs a hook that rewrites shell commands; restart your agent afterwards
rtk gain         # savings so far (also: --graph, --history, --daily)
rtk bypass <cmd> # run a command unfiltered (still tracked)
```

Per its README, built-in `Read`, `Grep` and `Glob` pass through untouched, token counts are estimated as bytes / 4 (so percentages are reliable and absolute numbers approximate), output is filtered once before it enters the conversation, so it does not break the prompt cache, and telemetry is off until you opt in with `rtk telemetry enable`. Its headline claim is 60 to 90 percent fewer tokens on common dev commands; that is the project's own figure, so measure it with `rtk gain` on your work.

## Check from here

`map-it-all doctor` reports whether `rtk` is on your PATH and prints the install line for your OS.
