# Packs, configuration and limits

Packs are auto-detected. Override or restrict them in `map-it-all.config.json` at the repo root (every key is optional):

```json
{
  "out": ".map-it-all",
  "memoryDir": null,
  "historyDirs": [".planning", "archive"],
  "ignore": ["**/vendor/**"],
  "packs": "auto",
  "convex":  { "dir": "convex" },
  "express": { "appFiles": ["server/app.ts"] },
  "expo":    { "dir": "apps/mobile" }
}
```

- `historyDirs`: folders treated as history. Their code never creates callers, routes or import edges; their docs still count as "linked only from history". Defaults: `.planning`, `audit`, `archive`, `graft`, `output`, `.claude`, `.agents`, `.cursor`.
- `packs`: `"auto"` or a list such as `["convex"]`.
- `driftIgnore`: regexes for doc references the drift check should skip, for docs that describe files in someone else's project (a tool's own README, a template). This repo uses it for its own docs.

## convex

Detected when `convex/` holds a `schema.ts` or a `_generated/` folder.

Reads: function definitions (`query`, `mutation`, `action`, `internal*`, `httpAction`), and every way they are referenced: `api.mod.fn`, `internal.mod.fn`, `anyApi.mod.fn`, `'mod:fn'` strings (gateways, `makeFunctionReference`), `` `mod:${name}` `` wrapper templates called with a string literal, crons, and mentions in current docs (manual runbooks are consumers). Tables come from `defineTable`, with `db.*('table')` reads and writes. HTTP routes come from `http.ts`.

`public: true` for public functions: phones and other clients call Convex by name, so no caller in the repo means VERIFY.

Limits: only top-level modules (`convex/foo.ts`); nested folders are not mapped.

## express

Detected from files that call `express()`. Routes are `app.get`/`router.post`/... with a literal path starting with `/`.

Mounts follow imports to the file that defines the router: named factory calls (`app.use('/api', fooRouter())`), default exports (`app.use('/x', router)`), `require`, nested `router.use('/deep', sub)` (prefixes compose), and routers declared and mounted in the same file. Mounts inside an `if` are flagged `conditional-mount` with the condition text. A router nobody mounts is `unmounted`.

Callers are string and template literals anywhere in the repo that equal the route path (`:param` and `${expr}` match any segment). A literal ending in `/` matches routes one segment deeper (`prefix`). Routes no current doc mentions are `undocumented`.

Limits: dynamic mount paths, several routers in one file with different mounts, and generic literals (`/health`) that happen to match unrelated strings.

## expo

Detected from a `package.json` depending on `expo` or `react-native` next to an `android/` folder with Kotlin.

Native modules: Kotlin `Name("X")` against JS `requireNativeModule('X')`, `requireOptionalNativeModule`, `requireNativeView`, `NativeModules.X`, or an app wrapper `getNativeModule('X')`, against the registration list `ExpoModulesPackageList.kt` (a Kotlin module missing from it is flagged: the release build will not find it). Screens against navigators. Kotlin classes against every other Android file (manifest included); a helper used only inside its own file is `same-file-only`.

## Generic checks (always on)

- **imports.json**: who imports each file. Resolves relative imports, tsconfig `paths` (with `extends`), and workspace packages.
- **docs**: Markdown files and their inbound links. Entry files (README, CLAUDE.md, AGENTS.md, ...) are not flagged.
- **drift**: current docs that name files or folders that no longer exist. A reference is dead only when no file or folder in the repo ends with that path, so loose names (`db.ts`) are not flagged.
- **tooling**: script files and npm scripts nothing references, tests outside every runner glob, env vars read but set nowhere in the checkout, worker URLs that point nowhere.
- **debt**: `TODO`, `@ts-ignore`, `eslint-disable`, `as unknown as`, `any`, `console.log` counts per file.
- **knip** (opt-in, `build --with-knip`): Knip's unused files, exports and dependencies. Needs Knip installed in your project. A Knip "unused file" that the import index shows importers for is tagged `map-has-importers` (almost certainly a Knip false positive).

## Writing a new pack

A pack exports `name`, `detect(ctx)` (returns options or `null`) and `extract(ctx, options, resolver)` returning `{ records, stats? }`. Use `ctx.sg(yaml)` for ast-grep rules (see `src/packs/util.mjs` for the per-language helper), `ctx.grep` for text, `finalize()` to attach counts and flags. Add a fixture to `test/fixtures.mjs` and an assertion that fails without your pack, then register the pack name in `src/build.mjs`.
