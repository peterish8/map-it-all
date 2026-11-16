// Expo / React Native pack: screens, native modules (Kotlin Name("X") <-> JS <-> package list) and
// Kotlin classes. Static import graphs cannot see manifest entries or native registration.

import path from 'node:path';
import { finalize, lineAt, ref } from '../records.mjs';

export const name = 'expo';

export function detect(ctx) {
  if (ctx.config.expo.dir) return { dir: ctx.config.expo.dir.replace(/\/+$/, '') };
  for (const f of ctx.files) {
    if (!/(^|\/)package\.json$/.test(f)) continue;
    try {
      const pkg = JSON.parse(ctx.read(f));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.expo || deps['react-native']) {
        const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
        if (ctx.files.some((g) => g.endsWith('.kt') && g.startsWith(dir ? `${dir}/android/` : 'android/'))) return { dir };
      }
    } catch { /* not valid JSON */ }
  }
  return null;
}

export function extract(ctx, { dir }) {
  const prefix = dir ? `${dir}/` : '';
  const tokens = ctx.tokenIndex((f) => f.startsWith(prefix));
  const routes = routeReferences(ctx, prefix);
  return { records: [...screens(ctx, tokens, prefix, routes), ...components(ctx, tokens, prefix, routes), ...nativeModules(ctx, prefix), ...kotlinClasses(ctx, tokens, prefix)] };
}

// Mask comments and strings so apparent calls inside either are not treated as executable code.
function codeMask(text) {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`\\]*(?:\\.[^`\\]*)*`)/g,
    (s) => s.replace(/[^\n]/g, ' '));
}

function routeReferences(ctx, prefix) {
  const registrations = [];
  const files = ctx.codeFiles.filter((f) => f.startsWith(prefix));
  for (const f of files) {
    const text = ctx.read(f);
    const mask = codeMask(text);
    for (const tag of text.matchAll(/<[\w$.]+\.Screen\b[^>]*>/g)) {
      if (mask[tag.index] !== '<') continue;
      const name = /\bname\s*=\s*(['"])([^'"]+)\1/.exec(tag[0])?.[2];
      const component = /\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag[0])?.[1];
      if (!name || !component) continue;
      // Require a direct relative import, including named aliases, to avoid joining unrelated
      // components with the same name. A same-file component is also valid.
      let target = f;
      const imports = /\bimport\s+([^;\n]+?)\s+from\s*(['"])([^'"]+)\2/g;
      for (const imp of text.matchAll(imports)) {
        if (!imp[3].startsWith('.') || !new RegExp(`\\b${component}\\b`).test(imp[1])) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), imp[3]));
        target = files.find((candidate) => candidate === base || /\.(tsx?|jsx?)$/.test(candidate) && candidate.replace(/\.(tsx?|jsx?)$/, '') === base) ?? '';
        break;
      }
      if (target) registrations.push({ name, target, path: f, line: lineAt(text, tag.index) });
    }
  }
  const byTarget = new Map();
  for (const registration of registrations) {
    if (!byTarget.has(registration.target)) byTarget.set(registration.target, []);
    byTarget.get(registration.target).push(ref(registration.path, registration.line, 'navigator'));
  }
  for (const f of files) {
    const text = ctx.read(f);
    const mask = codeMask(text);
    for (const call of text.matchAll(/\b(?:navigation|[A-Za-z_$][\w$]*Navigation)\s*\.\s*navigate\s*\(\s*(['"])([^'"]+)\1/g)) {
      if (mask[call.index] === ' ') continue;
      for (const target of new Set(registrations.filter((r) => r.name === call[2]).map((r) => r.target))) {
        byTarget.get(target).push(ref(f, lineAt(text, call.index), 'navigator'));
      }
    }
  }
  for (const [target, refs] of byTarget) {
    const seen = new Set();
    byTarget.set(target, refs.filter((r) => {
      const key = `${r.path}:${r.line}:${r.how}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }
  return byTarget;
}

function components(ctx, tokens, prefix, routes) {
  const out = [];
  for (const f of ctx.codeFiles) {
    if (!f.startsWith(prefix) || !/(^|\/)components\//.test(f) || !/\.(tsx|jsx)$/.test(f) || ctx.isTest(f)) continue;
    const name = path.posix.basename(f).replace(/\.(tsx|jsx)$/, '');
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) continue;
    const text = ctx.read(f);
    const exported = new RegExp(`\\bexport\\s+(?:(?:default\\s+)?(?:function|class)\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|default\\s+${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\})`);
    if (!exported.test(text)) continue;
    const refs = [...(routes.get(f) ?? []), ...tokenRefs(ctx, tokens, name, f, () => 'import')];
    out.push(finalize({ id: `mobile-component:${f}#${name}`, kind: 'mobile-component', name, path: f,
      line: lineAt(text, text.search(exported)), public: false, registered: routes.has(f), refs, flags: [] }, ctx));
  }
  return out;
}

function tokenRefs(ctx, tokens, name, own, howFor) {
  const refs = [];
  for (const f of tokens.get(name) ?? []) if (f !== own) refs.push(ref(f, null, howFor(f), name));
  return refs;
}

function screens(ctx, tokens, prefix, routes) {
  const out = [];
  for (const f of ctx.files) {
    if (!f.startsWith(prefix) || !/\/screens\//.test(f) || !/\.tsx?$/.test(f) || ctx.isTest(f)) continue;
    const name = path.posix.basename(f).replace(/\.tsx?$/, '');
    if (name === 'index') continue;
    const routeRefs = routes.get(f) ?? [];
    const refs = [...routeRefs, ...tokenRefs(ctx, tokens, name, f, (g) => (/\/navigation\/|Navigator/.test(g) ? 'navigator' : 'import'))
      .filter((r) => r.how !== 'navigator' || !routeRefs.some((route) => route.path === r.path))];
    out.push(finalize({
      id: `mobile-screen:${name}`, kind: 'mobile-screen', name, path: f, line: 1, public: false,
      registered: refs.some((r) => r.how === 'navigator'), refs, flags: [],
    }, ctx));
  }
  return out;
}

function nativeModules(ctx, prefix) {
  const kotlin = new Map(); // Name("X") -> { cls, path, line }
  for (const hit of ctx.grep(/\bName\(\s*"(\w+)"\s*\)/, (f) => f.startsWith(prefix) && f.endsWith('.kt'))) {
    const before = ctx.read(hit.path).slice(0, hit.index);
    const cls = [...before.matchAll(/\bclass\s+(\w+)/g)].pop()?.[1] ?? null;
    kotlin.set(hit.groups[0], { cls, path: hit.path, line: hit.line });
  }
  const packageList = ctx.files.find((f) => f.endsWith('ExpoModulesPackageList.kt'));
  const listText = packageList ? ctx.read(packageList) : '';

  // JS reaches a module by name through Expo's require*, NativeModules.X, or an app wrapper such as
  // getNativeModule('X'). Generics may nest (`getNativeModule<Record<string, X>>('X')`).
  const js = new Map();
  const usage = /(?:require(?:Optional)?Native(?:Module|View(?:Manager)?)|getNativeModule)\s*(?:<[\s\S]*?>)?\s*\(\s*['"](\w+)['"]|NativeModules\.(\w+)/;
  for (const hit of ctx.grep(usage, (f) => f.startsWith(prefix) && /\.(tsx?|jsx?)$/.test(f))) {
    const name = hit.groups[0] ?? hit.groups[1];
    if (!js.has(name)) js.set(name, []);
    js.get(name).push(ref(hit.path, hit.line, 'js'));
  }

  const out = [];
  for (const name of new Set([...kotlin.keys(), ...js.keys()])) {
    const k = kotlin.get(name);
    const rec = {
      id: `native-module:${name}`, kind: 'native-module', name, path: k?.path ?? js.get(name)[0].path, line: k?.line ?? js.get(name)[0].line,
      public: false, kotlinClass: k?.cls ?? null, refs: js.get(name) ?? [], flags: [],
    };
    if (k && k.cls && packageList && !listText.includes(`${k.cls}::class.java`)) rec.flags.push('not-in-ExpoModulesPackageList');
    if (!k && !/^Expo/.test(name)) rec.flags.push('no-kotlin-module');
    out.push(finalize(rec, ctx));
  }
  return out;
}

function kotlinClasses(ctx, tokens, prefix) {
  const out = [];
  const decl = /^(?:(?:public|internal|open|abstract|data|sealed|enum|annotation|inline|value|fun)\s+)*(class|object|interface)\s+(\w+)/gm;
  for (const f of ctx.files) {
    if (!f.startsWith(prefix) || !f.endsWith('.kt') || !/\/android\//.test(`/${f}`) || /\/src\/(test|androidTest)\//.test(f)) continue;
    const text = ctx.read(f);
    for (const m of text.matchAll(decl)) {
      const name = m[2];
      const refs = tokenRefs(ctx, tokens, name, f, (g) => (/AndroidManifest\.xml$|\/res\/xml\//.test(g) ? 'manifest' : 'ref'));
      // A helper type used only inside its own file is private structure, not an orphan.
      const sameFileOnly = refs.length === 0 && (text.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1;
      out.push(finalize({
        id: `kotlin:${f}#${name}`, kind: 'kotlin-class', name, path: f,
        line: text.slice(0, m.index).split('\n').length, public: false, refs,
        entry: sameFileOnly, flags: sameFileOnly ? ['same-file-only'] : [],
      }, ctx));
    }
  }
  return out;
}
