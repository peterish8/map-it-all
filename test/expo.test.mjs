import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildMap } from '../src/build.mjs';
import { connections, findRecords, formatConnections, loadStore } from '../src/store.mjs';
import { fixture, readRecords, write } from './fixtures.mjs';

test('Expo component registrations connect route-name navigation callers', async () => {
  const root = fixture();
  const out = path.join(root, '.map-it-all');
  const component = 'apps/mobile/src/components/AddToPlaylistModal.tsx';
  const navigator = 'apps/mobile/src/navigation/RootNavigator.tsx';
  const caller = 'apps/mobile/src/screens/LibraryScreen.tsx';
  try {
    write(root, component, 'export function AddToPlaylistModal() { return null; }\n');
    write(root, navigator, [
      "import { AddToPlaylistModal } from '../components/AddToPlaylistModal';",
      'const routes = <Stack.Navigator>',
      '  <Stack.Screen',
      '    name="AddToPlaylist"',
      '    component={AddToPlaylistModal}',
      '  />',
      '  <Stack.Screen component={AddToPlaylistModal} name="AddToPlaylist" />',
      '</Stack.Navigator>;',
    ].join('\n'));
    write(root, caller, "export function LibraryScreen() {\n  navigation.navigate('AddToPlaylist', { id: 1 });\n}\n");
    write(root, 'apps/mobile/src/other.ts', "const label = 'AddToPlaylist';\n// navigation.navigate('AddToPlaylist');\nconst example = \"navigation.navigate('AddToPlaylist')\";\n");
    write(root, 'apps/mobile/src/components/notAComponent.tsx', 'export const notAComponent = () => null;\n');
    await buildMap({ root, out });
    let store = loadStore(out);
    assert.match(findRecords(store, { query: 'AddToPlaylistModal' }), /mobile-component:.*AddToPlaylistModal/);
    assert.match(formatConnections(store, component), /\(1 map records;/);
    const refs = connections(store, component).callers;
    assert.ok(refs.some((r) => r.path === navigator && r.how === 'navigator'));
    assert.ok(refs.some((r) => r.path === caller && r.line === 2 && r.how === 'navigator'));
    assert.ok(!refs.some((r) => r.path.endsWith('/other.ts')));
    assert.equal(store.records.some((r) => r.path.endsWith('/notAComponent.tsx')), false);
    const first = readRecords(out, 'expo');
    await buildMap({ root, out });
    store = loadStore(out);
    assert.deepEqual(readRecords(out, 'expo'), first, 'repeated builds produce identical records');
    const stored = store.byPath.get(component)[0].refs;
    assert.equal(new Set(stored.map((r) => `${r.path}:${r.line}:${r.how}`)).size, stored.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
