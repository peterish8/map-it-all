# Dependencies and version-pinned docs

`map-it-all deps` ties each declared dependency to the files that import it. With online lookups allowed, it adds known vulnerabilities and deprecations for the versions you have installed, and traces a vulnerable transitive package back to the direct dependency that pulls it in and from there to your files. `map-it-all docs <package> "<question>"` saves a short docs excerpt for the installed version as a memory note. Its output is the same package view `deps <package>` prints (versions, importers, advisories, deprecation, the OSV credit when advisories appear) followed by the saved note, so an online `docs` run also makes the OSV and npm registry requests below, not only the docs requests.

The same data is the `deps` MCP tool (in the `standard` and `full` profiles).

```bash
map-it-all deps                              # offline: versions, importers, possibly unused packages
map-it-all deps --online                     # also advisories and deprecations, for this run only
map-it-all deps lodash                       # one package: versions, importers, advisories
map-it-all deps --only vulnerable            # vulnerable | deprecated | unused
map-it-all deps --online --refresh           # ignore the cache and ask again
map-it-all docs lodash "how do I debounce"   # package detail, then a version-pinned docs note (the lookup needs the network)
```

## Network: off unless you turn it on

The build never touches the network. Lookups happen only when the user allows them, in this order of precedence:

1. `MAP_IT_ALL_OFFLINE=1` always wins. It forces the network off, even with `--online` or `"network": true` (use it in CI or on air-gapped machines).
2. Otherwise any one of these turns it on:
   - `--online` on `deps`, `docs` or `mcp` (this run or this server process only),
   - `"network": true` in `map-it-all.config.json`,
   - `MAP_IT_ALL_ONLINE=1`.
3. Otherwise it is off.

`map-it-all init --online` writes `"network": true` into `map-it-all.config.json`, keeping every other key. Plain `init` never does. `--dry-run` previews it.

An agent cannot switch it on. The `deps` tool's `refresh` argument (and the CLI `--refresh` flag, on `deps` and `docs`) only asks for fresh data; while the policy says off, the answer is still "off" and no request is made.

`map-it-all doctor` prints the effective policy (and why) and the age of the advisory cache.

## What is sent

OSV receives package names and versions in query bodies, then advisory IDs in detail URL paths. npm and docs hosts receive their requested URLs, your remote IP address, and ordinary HTTP/TLS metadata, including the `map-it-all/<version>` user-agent. Network metadata may reveal package or repository names; do not assume names stay private.

- to `https://api.osv.dev` (OSV.dev): which known vulnerabilities affect each name and version, then the details of each advisory id,
- to `https://registry.npmjs.org`: whether a version is deprecated, and its homepage and repository link,
- for `docs`: the package's homepage (looking for `llms.txt`) and its GitHub README, at the addresses the registry returned.

Application payloads: request bodies and URLs carry only npm package names and versions, advisory ids, and (for `docs`) the homepage and GitHub README addresses the registry returned. map-it-all adds no local file paths, source code, usernames or account details to them. That is a statement about the payloads, not about what the network can see: the remote services and anything on the path still see your IP address, the destination host names, timing and the `map-it-all/<version>` user-agent, and package or repository names in URLs can point back to your project.

What comes back is untrusted text. It is stripped of control characters, size-capped, labelled in the output, and never executed or treated as instructions. Links a package author controls (docs URLs) may only be public `https` hosts: localhost, private and link-local addresses are refused, redirects are followed manually (at most three) and re-checked, and responses are size-limited.

Advisory data: [OSV.dev](https://osv.dev), which includes the GitHub Advisory Database (CC BY 4.0). Credit appears in the tool output.

## Caches and expiry

| What | Where | Lifetime |
| --- | --- | --- |
| Which advisories affect `name@version` | `.map-it-all/deps-cache.json` | 24 hours |
| Advisory details (severity, summary, fixed versions) | same file | 7 days |
| npm deprecation, homepage, repository | same file | 7 days |
| Docs notes | `.map-it-all/memory/`, pinned to `name@version` | until that version changes |

The cache is keyed by `name@version`. Within each entry's lifetime (24 hours or 7 days, as above) an unchanged lockfile costs no requests; once an entry expires (for advisories, after 24 hours), or a package version changes, the next online run looks it up again, even for an unchanged lockfile. One lookup can mean several requests: an OSV query, one request per advisory id found, and a registry request. `--refresh` ignores the cache (only when the network is allowed): package lookups, advisory details and registry lookups are fetched again, with details and registry lookups still capped at 300 per run (see Partial results). The cache lives in the local, gitignored map folder; delete the file to start over. `map-it-all doctor` shows the newest and oldest advisory entry ages, and whether the cache is missing, fresh (every entry under 24 hours), stale (all 24 hours or older) or mixed (some entries 24 hours or older; those refresh on the next online run). An entry exactly 24 hours old counts as stale.

With the network off, `deps` still shows whatever is cached, labelled with its age, plus how many versions have never been checked.

## Partial results

A lookup can fail halfway: the service is unreachable, rate limited, or the lockfile is large. `deps` then says so instead of reporting a clean result, and keeps three cases apart: **failed** (the request was made and failed: `N package lookup(s) failed to refresh`, `N advisory detail(s) failed to fetch`, `N cached advisory detail(s) failed to refresh`), **pending** (wanted, but the per-run cap was reached first, so it was not attempted: `not fetched yet (at most 300 per run)`, `not refreshed yet`, `N not attempted yet` for registry lookups) and **stale** (older cached data is being shown in place of a refresh that has not succeeded). An advisory id whose details could not be fetched stays listed as `UNKNOWN` ("details not fetched yet"), and the summary is never reported as complete or "No known vulnerabilities". Treat "not checked" as unknown, not as safe.

Limits per run: 500 package versions per OSV batch (paged), at most 300 advisory details and 300 registry lookups. Advisory details use one queue holding both the ids with no record and the ids whose record expired (every id with `--refresh`): the entry attempted longest ago goes first, a failure moves it to the back, and no id is requested twice in a run, so a group that keeps failing cannot starve the other. Registry lookups use the same rule across missing, expired and failed versions, including under `--refresh`. The output reports failed, pending, stale and 404 coverage, so missing registry data does not imply deprecation coverage is complete. Run again online to continue. Failed and pending markers are saved in the cache and survive offline runs, so an offline read right after a failed refresh still shows the result as partial; a success clears the marker. The result and session brief remain partial until the affected entries refresh successfully, and "No known vulnerabilities" is suppressed while advisory coverage is unresolved.

## Supported lockfiles and what they can attribute

| Lockfile | Versions and advisories | "via X" attribution (transitive to direct) |
| --- | --- | --- |
| `package-lock.json` (v1, v2, v3) | yes | yes |
| `yarn.lock` (classic, v1) | yes | yes |
| `pnpm-lock.yaml` (v6+ and v9 importers) | yes | no: dependency edges are not read, so a transitive finding cannot be traced to your direct dependency |

Not supported: Yarn Berry (`yarn.lock` v2+), Bun lockfiles, `npm-shrinkwrap.json` quirks. Each `package.json` uses the nearest lockfile at or above its folder (so workspaces share the root lockfile).

Attribution limits to keep in mind:

- Exposure is by import, not by call path: "exposed in N files" means those files import the direct dependency that pulls the vulnerable package in. It does not prove the vulnerable code runs.
- Imports are found statically. String-built `require`, config-only use and CLI use (a package run from a script) are not seen; production dependencies nothing imports, no script runs and no config names are listed as "possibly unused", which is a lead and never proof.
- `peerDependencies`, workspace packages and non-registry ranges (`file:`, `git`) are skipped. Dev dependencies are reported like others; weigh them accordingly.
- Advisories that carry only a CVSS v4 vector are reported with severity `UNKNOWN`.

## Docs: sources and stale pins

`docs <package> "<question>"` prints the package view, then looks, in order, for:

1. the package's own `llms.txt` (at its homepage), keeping the title, summary and the lines that match your question, and following one same-site Markdown link if it matches,
2. the README in its GitHub repository.

The excerpt is selected with shallow question-term/token matching and capped at about 425 tokens; this is retrieval, not semantic answering. It is saved as a memory note titled `docs: name@version - question`. The source is current at fetch time, and compatibility with the installed version is unverified. The package pin is only a local invalidation anchor: it can become stale when the lockfile version changes, but does not prove the source matches that version. Asking again is free and offline while the version is unchanged.

When the lockfile moves to another version the note becomes `stale` (and `orphaned` if the package is removed). `memory list` and `recall` read the saved map and do not rebuild it, so a lockfile-only change shows up there only after a command that rebuilds the map (`build`, `deps`, `docs`, or the session hook). A stale note is still shown with a warning, and with the network allowed a new lookup saves a note for the new version. `memory confirm` re-pins a note after you have checked it against the new version.

Without the network, `docs` returns the saved note if there is one, or says that nothing is saved.

## Configuration summary

```json
{ "network": true }
```

in `map-it-all.config.json`. Environment: `MAP_IT_ALL_ONLINE=1`, `MAP_IT_ALL_OFFLINE=1` (wins). Test overrides: `MAP_IT_ALL_OSV_URL` and `MAP_IT_ALL_NPM_URL` point the two service clients at a local server.
