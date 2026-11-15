// A small project that exercises every registration style the map claims to understand.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function write(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

export function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'map-it-all-test-'));

  write(root, 'package.json', JSON.stringify({ name: 'fx', workspaces: ['packages/*'], scripts: { test: 'node --test', 'orphan-script': 'echo hi' } }));
  write(root, 'tsconfig.json', '{\n  // comments and trailing commas are legal in tsconfig\n  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["packages/shared/*"], }, },\n}\n');
  write(root, 'packages/shared/package.json', JSON.stringify({ name: '@fx/shared', main: 'src/index.ts' }));
  write(root, 'packages/shared/src/index.ts', 'export const idx = 1;\n');
  write(root, 'packages/shared/a.ts', 'export const a = 1;\n');
  write(root, 'packages/shared/unused.ts', 'export const u = 1;\n');

  // Convex
  write(root, 'convex/lib.ts', [
    "import { query, mutation, internalMutation } from './_generated/server';",
    'export const used = query({ handler: async () => 1 });',
    'export const dead = mutation({ handler: async () => 2 });',
    'export const sweep = internalMutation({ handler: async () => 3 });',
    'export const viaWrapper = query({ handler: async () => 4 });',
  ].join('\n'));
  write(root, 'convex/_generated/api.d.ts', 'export {};\n');
  write(root, 'convex/crons.ts', "crons.interval('sweep', { minutes: 5 }, internal.lib.sweep);\n");
  write(root, 'convex/schema.ts', 'export default defineSchema({\n  things: defineTable({}),\n  ghosts: defineTable({}),\n});\n');
  write(root, 'convex/things.ts', "import { query } from './_generated/server';\nexport const list = query({ handler: async (ctx) => ctx.db.query('things').collect() });\n");
  write(root, 'web/call.ts', "import { a } from '@shared/a';\nimport { idx } from '@fx/shared';\nexport const x = [api.lib.used, a, idx];\n");
  write(root, 'mobile/wrap.ts', ['const q = (name: string) => makeFunctionReference(`lib:${name}`);', "export const ref = q('viaWrapper');"].join('\n'));
  // History must not create callers, routes or imports.
  write(root, 'archive/old.ts', "import express from 'express';\nconst router = express.Router();\nrouter.get('/ghost', h);\nexport const stale = api.lib.dead;\n");

  // Express: flat mount, conditional mount, default-export router, nested router, same-file router.
  write(root, 'server/app.ts', [
    "import express from 'express';",
    "import { fooRouter } from './routes/foo';",
    "import { barRouter } from './routes/bar';",
    "import defRouter from './routes/def';",
    "import nested from './routes/nested';",
    'const app = express();',
    'const adminRouter = express.Router();',
    "adminRouter.get('/stats', handler);",
    "app.use('/api', fooRouter());",
    "if (process.env.EXTRA) app.use('/api', barRouter());",
    "app.use('/def', defRouter);",
    "app.use('/v2', nested);",
    "app.use('/admin', adminRouter);",
    "app.get('/health', handler);",
  ].join('\n'));
  write(root, 'server/routes/foo.ts', [
    "import { Router } from 'express';",
    'export function fooRouter() {',
    '  const router = Router();',
    "  router.get('/foo/:id', handler);",
    "  router.post('/never-called', handler);",
    '  return router;',
    '}',
  ].join('\n'));
  write(root, 'server/routes/bar.ts', "import { Router } from 'express';\nexport function barRouter() {\n  const router = Router();\n  router.get('/bar', handler);\n  return router;\n}\n");
  write(root, 'server/routes/def.ts', "import express from 'express';\nconst router = express.Router();\nrouter.get('/d', handler);\nexport default router;\n");
  write(root, 'server/routes/nested.ts', "import express from 'express';\nimport deep from './deep';\nconst router = express.Router();\nrouter.use('/deep', deep);\nrouter.get('/top', handler);\nexport default router;\n");
  write(root, 'server/routes/deep.ts', "import express from 'express';\nconst router = express.Router();\nrouter.get('/x', handler);\nexport default router;\n");
  write(root, 'server/routes/orphan.ts', "import { Router } from 'express';\nconst router = Router();\nrouter.get('/lost', handler);\nexport default router;\n");
  write(root, 'web/api.ts', 'export const get = (id: string) => fetch(`/api/foo/${encodeURIComponent(id)}`);\n');
  write(root, 'docs/api.md', 'GET /api/foo/:id\n');

  // Docs drift
  write(root, 'CLAUDE.md', 'See `convex/lib.ts` and `server/gone.ts`.\n\n```\ncd phantom/dir\n```\n');

  // Expo + Kotlin
  write(root, 'apps/mobile/package.json', JSON.stringify({ name: 'mob', dependencies: { expo: '^52' } }));
  write(root, 'apps/mobile/android/app/src/main/java/app/FooModule.kt', 'class FooModule : Module() {\n  override fun definition() = ModuleDefinition { Name("Foo") }\n}\nclass Helper\n');
  write(root, 'apps/mobile/android/app/src/main/java/expo/modules/ExpoModulesPackageList.kt', 'val list = listOf<Class<*>>()\n');
  write(root, 'apps/mobile/src/screens/HomeScreen.tsx', 'export const HomeScreen = () => null;\n');
  write(root, 'apps/mobile/src/screens/LostScreen.tsx', 'export const LostScreen = () => null;\n');
  write(root, 'apps/mobile/src/navigation/Nav.tsx', "import { HomeScreen } from '../screens/HomeScreen';\nexport const nav = HomeScreen;\n");
  write(root, 'apps/mobile/src/native.ts', "const foo = requireNativeModule('Foo');\nexport default foo;\n");

  return root;
}

export const readRecords = (out, name) => JSON.parse(readFileSync(path.join(out, `${name}.json`), 'utf8')).records;
export const byId = (records, id) => records.find((r) => r.id === id);
