import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { typescriptGraph, resolveSpecifier, loadTypeScript } from '../src/typescript.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'icr-ts-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

function analyse(files) {
  const dir = tree(files);
  try {
    return typescriptGraph(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const find = (g, from, to) => g.edges.filter((e) => e.from === from && e.to === to);

test('the typescript parser is the real one', () => {
  const ts = loadTypeScript();
  assert.ok(ts.createSourceFile, 'no createSourceFile, so this is not the compiler API');
  assert.match(ts.version, /^\d+\.\d+/);
});

test('import type is erased', () => {
  const g = analyse({
    'a.ts': "import type { B } from './b';\nexport const f = (x: B) => x;\n",
    'b.ts': 'export interface B { n: number }\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.timing, 'erased');
  assert.equal(e.kind, 'import-type');
});

test('a value import used only as a type is elided, and labelled differently', () => {
  const g = analyse({
    'a.ts': "import { B } from './b';\nexport const f = (x: B) => x;\n",
    'b.ts': 'export interface B { n: number }\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.timing, 'erased');
  assert.equal(e.kind, 'elided');
  assert.match(e.detail, /verbatimModuleSyntax/);
});

test('a mixed import with one real value use is not erased', () => {
  const g = analyse({
    'a.ts': "import { type T, thing } from './b';\nexport const f = (x: T) => thing(x);\n",
    'b.ts': 'export type T = number;\nexport const thing = (n: T) => n;\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.timing, 'import-time');
});

test('a value used inside a function is not a module time use', () => {
  const g = analyse({
    'a.ts': "import { thing } from './b';\nexport const f = () => thing();\n",
    'b.ts': 'export const thing = () => 1;\n',
  });
  assert.equal(find(g, 'a.ts', 'b.ts')[0].needsBinding, false);
});

test('a value used at the top level is a module time use', () => {
  const g = analyse({
    'a.ts': "import { thing } from './b';\nexport const value = thing();\n",
    'b.ts': 'export const thing = () => 1;\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.needsBinding, true);
  assert.deepEqual(e.names, ['thing']);
});

test('extends is evaluated at module time, a method body is not', () => {
  const g = analyse({
    'a.ts': "import { Base } from './b';\nexport class Sub extends Base {}\n",
    'c.ts': "import { Base } from './b';\nexport class Other {\n  make() {\n    return new Base();\n  }\n}\n",
    'b.ts': 'export class Base {}\n',
  });
  assert.equal(find(g, 'a.ts', 'b.ts')[0].needsBinding, true);
  assert.equal(find(g, 'c.ts', 'b.ts')[0].needsBinding, false);
});

test('a static field initialiser runs at module time, an instance field does not', () => {
  const g = analyse({
    'a.ts': "import { v } from './b';\nexport class K {\n  static s = v;\n}\n",
    'c.ts': "import { v } from './b';\nexport class J {\n  i = v;\n}\n",
    'b.ts': 'export const v = 1;\n',
  });
  assert.equal(find(g, 'a.ts', 'b.ts')[0].needsBinding, true);
  assert.equal(find(g, 'c.ts', 'b.ts')[0].needsBinding, false);
});

test('a hoisted function export is recorded, a const arrow is not', () => {
  const g = analyse({
    'a.ts': 'export function hoisted() {\n  return 1;\n}\nexport const notHoisted = () => 1;\nexport class Klass {}\nexport var oldStyle = 1;\n',
  });
  assert.deepEqual(g.hoisted['a.ts'], ['hoisted', 'oldStyle']);
});

test('export { f } where f is a function declaration counts as hoisted', () => {
  const g = analyse({ 'a.ts': 'function f() {\n  return 1;\n}\nexport { f };\nexport { f as g };\n' });
  assert.deepEqual(g.hoisted['a.ts'], ['f', 'g']);
});

test('a bare side effect import is a real edge', () => {
  const g = analyse({ 'a.ts': "import './b';\n", 'b.ts': 'console.log(1);\n' });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.kind, 'side-effect');
  assert.equal(e.timing, 'import-time');
  assert.equal(e.needsBinding, false);
});

test('a re-export is a runtime edge, a type re-export is not', () => {
  const g = analyse({
    'a.ts': "export { thing } from './b';\nexport type { T } from './c';\nexport * from './d';\n",
    'b.ts': 'export const thing = 1;\n',
    'c.ts': 'export type T = number;\n',
    'd.ts': 'export const other = 1;\n',
  });
  assert.equal(find(g, 'a.ts', 'b.ts')[0].timing, 'import-time');
  assert.equal(find(g, 'a.ts', 'c.ts')[0].timing, 'erased');
  assert.equal(find(g, 'a.ts', 'd.ts')[0].kind, 're-export');
});

test('a dynamic import with a literal is deferred, with a variable it is unresolvable', () => {
  const g = analyse({
    'a.ts': "export async function f(n: string) {\n  await import('./b');\n  return import(n);\n}\n",
    'b.ts': 'export const x = 1;\n',
  });
  assert.equal(find(g, 'a.ts', 'b.ts')[0].timing, 'deferred');
  assert.equal(g.unresolved.length, 1);
  assert.match(g.unresolved[0].reason, /computed specifier/);
  assert.equal(g.unresolved[0].line, 3);
});

test('destructuring a require is a binding need, a plain require is not', () => {
  const g = analyse({
    'a.cjs': "const { thing } = require('./b.cjs');\nmodule.exports = { thing };\n",
    'c.cjs': "const b = require('./b.cjs');\nmodule.exports = { get: () => b.thing };\n",
    'b.cjs': 'exports.thing = 1;\n',
  });
  assert.equal(find(g, 'a.cjs', 'b.cjs')[0].needsBinding, true);
  assert.equal(find(g, 'c.cjs', 'b.cjs')[0].needsBinding, false);
});

test('import = require() is an eager edge', () => {
  const g = analyse({
    'a.ts': "import b = require('./b');\nexport const v = b;\n",
    'b.ts': 'export = 1;\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.kind, 'import-equals');
  assert.equal(e.timing, 'import-time');
});

test('an import in a comment or a string is not an import', () => {
  const g = analyse({
    'a.ts': "// import { x } from './b';\nconst s = \"import { x } from './b'\";\nexport const t = s;\n",
    'b.ts': 'export const x = 1;\n',
  });
  assert.equal(g.edges.length, 0, 'a grep would have found two imports here');
});

test('bare specifiers are external and are counted, not reported as unresolved', () => {
  const g = analyse({ 'a.ts': "import { readFile } from 'node:fs';\nexport const f = readFile;\n" });
  assert.equal(g.edges.length, 0);
  assert.equal(g.unresolved.length, 0);
  assert.equal(g.externalCount, 1);
});

test('a .js specifier resolves to the .ts file next to it', () => {
  const dir = tree({ 'a.ts': "import { x } from './b.js';\nexport const y = x;\n", 'b.ts': 'export const x = 1;\n' });
  try {
    assert.equal(resolveSpecifier(join(dir, 'a.ts'), './b.js'), join(dir, 'b.ts'));
    const g = typescriptGraph(dir);
    assert.equal(find(g, 'a.ts', 'b.ts').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory specifier resolves to its index file', () => {
  const g = analyse({
    'a.ts': "import { x } from './sub';\nexport const y = x;\n",
    'sub/index.ts': 'export const x = 1;\n',
  });
  assert.equal(find(g, 'a.ts', 'sub/index.ts').length, 1);
});

test('a namespace import read at module time cannot claim hoisting safety', () => {
  const g = analyse({
    'a.ts': "import * as b from './b';\nexport const v = b.thing;\n",
    'b.ts': 'export function thing() {\n  return 1;\n}\n',
  });
  const e = find(g, 'a.ts', 'b.ts')[0];
  assert.equal(e.needsBinding, true);
  assert.equal(e.names, null, 'a namespace read is not covered by any one export name');
});

test('tsx and jsx parse without being mistaken for type assertions', () => {
  const g = analyse({
    'a.tsx': "import { Thing } from './b';\nexport const El = () => <Thing />;\n",
    'b.tsx': 'export const Thing = () => null;\n',
  });
  assert.equal(g.parseErrors.length, 0);
  assert.equal(find(g, 'a.tsx', 'b.tsx').length, 1);
});
