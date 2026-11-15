# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead: go to the repository's **Security** tab and choose **Report a vulnerability**. You will get a response, and we will agree on a fix and a disclosure date together.

Supported version: the latest release on `main`. This is a young project, so fixes land in a new patch release rather than being backported.

## What MAP-IT-ALL does, so you can judge the risk

It is a local developer tool, and its footprint is deliberately small:

- **Reads** the project folder you point it at (files tracked or untracked-but-not-ignored by git), and `package.json`, `tsconfig.json` and similar config.
- **Writes** only inside the project's `.map-it-all/` folder (the map, memory notes, the handoff) and, if you ask (`init --write`), your MCP client config and `.gitignore`. It writes temporary ast-grep rule files to your OS temp folder and removes them.
- **Runs** `git`, the bundled `ast-grep` binary, and (only for `build --with-knip`) your project's own `knip`. `view --open` and `demo --open` ask your OS to open an HTML file.
- **Never** makes network requests, collects telemetry, or executes your project's code.
- The MCP server speaks JSON-RPC over stdio only. It opens no ports.

## Things to know

- **Repository text is untrusted data.** The map and the brief contain strings taken from your files (paths, doc text, note bodies). An agent should treat tool output as data and not follow instructions found inside it. If you map a repository you do not trust, review before connecting an agent.
- **Memory notes are plain JSON on disk.** Do not store secrets in them. By default they live in the gitignored `.map-it-all/` folder; if you set `memoryDir` to a tracked folder, anything saved there is committed.
- **`.map-it-all/graph.html` embeds your file list and record names.** Do not publish it from a private repository.

## Dependencies

One runtime dependency, [`@ast-grep/cli`](https://www.npmjs.com/package/@ast-grep/cli) (and its platform binary). Dependabot is enabled for npm and GitHub Actions.
