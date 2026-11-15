# Live dependency and docs validation — 2026-11-15

## Scope and evidence

This is a dated manual observation of a live-service check completed on 2026-11-15 UTC in a disposable project. The run did not change repository files or Git state. It is not an automated CI test, a guarantee that the services will return the same data later, or a test of npm's network traffic.

The temporary project's `index.js` imported these direct dependencies:

| Package | Version |
| --- | --- |
| `lodash` | `4.17.20` |
| `hono` | `4.13.18` |
| `left-pad` | `1.3.0` |

## Observed live results

- `deps --online` found HIGH `lodash@4.17.20`, advisory [GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm) (`CVE-2021-23337`), fixed in `4.17.21`. The vulnerable dependency was exposed through `index.js:1`.
- Registry metadata covered all three of three direct versions, with no partial warning. `left-pad@1.3.0` was reported deprecated.
- The real OSV detail endpoint [https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm](https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm) returned HTTP 200. The UTF-8 re-encoded full response SHA256 was `3268f1c34ac513fba357684127eb2dee52c0db3fa38c99e1a40276242f5d6452`.
- The Hono source endpoint [https://hono.dev/llms.txt](https://hono.dev/llms.txt) returned HTTP 200.
- The fallback README endpoint [https://raw.githubusercontent.com/stevemao/left-pad/HEAD/README.md](https://raw.githubusercontent.com/stevemao/left-pad/HEAD/README.md) returned HTTP 200.
- The docs command saved notes for `hono@4.13.18` and `left-pad@1.3.0`, each marked “source current when fetched; compatibility with installed version unverified”. After the temporary lockfile was changed to `hono@4.13.17` and `left-pad@1.2.0` and the map was rebuilt, offline lookups showed the prior notes as stale/out-of-date. Registry lookups confirmed both lower versions exist.

Sanitized result excerpt (a concise summary of the observed output, not a verbatim terminal transcript):

```text
HIGH lodash@4.17.20 — GHSA-35jh-r3h4-6jhm (CVE-2021-23337); fixed in 4.17.21
exposed source: index.js:1
Registry metadata: 3 of 3 direct versions cached; no partial warning
Deprecated: left-pad@1.3.0
Docs notes saved: hono@4.13.18; left-pad@1.3.0
After lockfile change and map rebuild: prior notes shown as stale/out-of-date offline
```

## Repeat in a disposable project

From the repository root, use a separate temporary project directory represented below as `<project>`. `<map>` means the repository checkout containing `bin/map-it-all.mjs`; both are placeholders, not literal paths. Do not point `<project>` at this repository.

1. Create `<project>`, then initialize it and install exact direct versions:

   ```sh
   cd <project>
   npm init -y
   npm install --save-exact lodash@4.17.20 hono@4.13.18 left-pad@1.3.0
   ```

   Set `index.js` to import all three packages:

   ```js
   import lodash from 'lodash';
   import { Hono } from 'hono';
   import leftPad from 'left-pad';
   ```

   Keep the generated `package-lock.json`. This installation is performed by npm and its traffic is outside the CLI HTTPS trace described below.
3. Build the disposable project's map and run the live check:

   ```sh
   node <map>/bin/map-it-all.mjs build --root <project>
   node <map>/bin/map-it-all.mjs deps --root <project> --online
   node <map>/bin/map-it-all.mjs docs hono --root <project> --online "configuration and usage"
   node <map>/bin/map-it-all.mjs docs left-pad --root <project> --online "usage"
   ```

4. To observe stale-pin behavior, change the temporary project's exact `package.json` dependency versions to `hono@4.13.17` and `left-pad@1.2.0`, then refresh the lockfile without running package lifecycle scripts. Rebuild after every lockfile change so the map's dependency snapshot reflects the new lock:

   ```sh
   npm install --package-lock-only --ignore-scripts
   node <map>/bin/map-it-all.mjs build --root <project>
   node <map>/bin/map-it-all.mjs docs hono --root <project> "configuration and usage"
   node <map>/bin/map-it-all.mjs docs left-pad --root <project> "usage"
   ```

The offline `docs` calls above exercise the saved notes after the rebuild; do not add `--online` to those final lookups.

## Network and privacy scope

The observed CLI HTTPS trace counted `api.osv.dev` 5 requests, `registry.npmjs.org` 3, `hono.dev` 1, and `raw.githubusercontent.com` 1. This is the CLI trace only; it does not audit requests made by npm itself. In particular, `npm install` can make npm registry requests outside these counts.

The real service URLs observed were OSV [https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm](https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm), Hono [https://hono.dev/llms.txt](https://hono.dev/llms.txt), and the left-pad fallback README [https://raw.githubusercontent.com/stevemao/left-pad/HEAD/README.md](https://raw.githubusercontent.com/stevemao/left-pad/HEAD/README.md). CLI requests were limited to the package/version advisory and registry lookups and the selected public docs sources. Remote hosts still receive ordinary connection metadata, including the source IP, request timing, host, and user-agent; package and repository names in requests may identify project dependencies.

## Fixture correspondence

The checked-in representative OSV fixture matches the live record's ID, summary, CVSS vector, HIGH severity, and affected range. The live affected package object also contains `purl: "pkg:npm/lodash"`; that field was added to the fixture while retaining its other representative fields. The full live response hash above applies to the captured response, not to the checked-in fixture.
