import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pythonGraph, moduleNames, isAncestorPackage } from '../src/python.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'icr-py-'));
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
    return pythonGraph(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const find = (g, from, to) => g.edges.filter((e) => e.from === from && e.to === to);

test('an import inside a function is deferred, the same import at module level is not', () => {
  const g = analyse({
    'a.py': 'import b\n',
    'c.py': 'def go():\n    import b\n    return b\n',
    'b.py': 'X = 1\n',
  });
  assert.equal(find(g, 'a.py', 'b.py')[0].timing, 'import-time');
  assert.equal(find(g, 'c.py', 'b.py')[0].timing, 'deferred');
});

test('a TYPE_CHECKING import is erased', () => {
  const g = analyse({
    'a.py': 'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from b import Thing\n',
    'b.py': 'class Thing: pass\n',
  });
  assert.equal(find(g, 'a.py', 'b.py')[0].timing, 'erased');
});

test('an import under `if __name__ == "__main__"` does not run on import', () => {
  const g = analyse({
    'a.py': 'X = 1\n\nif __name__ == "__main__":\n    from b import Y\n    print(Y)\n',
    'b.py': 'Y = 2\n',
  });
  const e = find(g, 'a.py', 'b.py')[0];
  assert.equal(e.timing, 'deferred');
  assert.match(e.detail, /__main__/);
});

test('a conditional import at module level still runs at import time, and is flagged', () => {
  const g = analyse({
    'a.py': 'try:\n    import b\nexcept ImportError:\n    b = None\n',
    'b.py': 'X = 1\n',
  });
  const e = find(g, 'a.py', 'b.py')[0];
  assert.equal(e.timing, 'import-time');
  assert.equal(e.conditional, true);
});

test('from-import needs a name, plain import does not', () => {
  const g = analyse({
    'a.py': 'from c import THING\n',
    'b.py': 'import c\n\ndef go():\n    return c.THING\n',
    'c.py': 'THING = 1\n',
  });
  assert.equal(find(g, 'a.py', 'c.py')[0].needsBinding, true);
  assert.equal(find(g, 'b.py', 'c.py')[0].needsBinding, false);
});

test('a plain import whose name is used while the module body runs does need it', () => {
  const g = analyse({
    'a.py': 'import c\n\nVALUE = c.THING\n',
    'c.py': 'THING = 1\n',
  });
  const e = find(g, 'a.py', 'c.py')[0];
  assert.equal(e.needsBinding, true);
  assert.match(e.detail, /module body/);
});

test('a name used only in a postponed annotation is not a module time use', () => {
  const g = analyse({
    'a.py': 'from __future__ import annotations\n\nimport c\n\ndef f(x: c.Thing) -> c.Thing:\n    return x\n',
    'c.py': 'class Thing: pass\n',
  });
  assert.equal(find(g, 'a.py', 'c.py')[0].needsBinding, false);
});

test('a class base is evaluated at import time, so it does count', () => {
  const g = analyse({
    'a.py': 'import c\n\nclass Sub(c.Base):\n    pass\n',
    'c.py': 'class Base: pass\n',
  });
  assert.equal(find(g, 'a.py', 'c.py')[0].needsBinding, true);
});

test('importlib with a literal is an edge, importlib with a variable is an admission', () => {
  const g = analyse({
    'a.py': 'import importlib\n\nm = importlib.import_module("c")\n\n\ndef load(n):\n    return importlib.import_module(n)\n',
    'c.py': 'X = 1\n',
  });
  const e = find(g, 'a.py', 'c.py')[0];
  assert.equal(e.kind, 'importlib');
  assert.equal(e.timing, 'import-time');
  assert.equal(g.unresolved.length, 1);
  assert.equal(g.unresolved[0].file, 'a.py');
  assert.match(g.unresolved[0].reason, /computed/);
});

test('a string that looks like an import is not one', () => {
  const g = analyse({
    'a.py': 'DOC = """\nimport c\nfrom c import THING\n"""\n# import c\n',
    'c.py': 'THING = 1\n',
  });
  assert.equal(g.edges.length, 0, 'a grep would have found three imports here');
});

test('a file that does not parse is reported rather than skipped silently', () => {
  const g = analyse({ 'a.py': 'def broken(:\n', 'b.py': 'X = 1\n' });
  assert.equal(g.parseErrors.length, 1);
  assert.equal(g.parseErrors[0].file, 'a.py');
  assert.match(g.parseErrors[0].message, /syntax error at line 1/);
});

test('star imports need the whole namespace', () => {
  const g = analyse({ 'a.py': 'from c import *\n', 'c.py': 'X = 1\n' });
  const e = find(g, 'a.py', 'c.py')[0];
  assert.equal(e.kind, 'from-star');
  assert.equal(e.needsBinding, true);
});

test('relative imports resolve against the package', () => {
  const g = analyse({
    'pkg/__init__.py': '',
    'pkg/a.py': 'from .b import Y\nfrom . import c\n',
    'pkg/b.py': 'Y = 1\n',
    'pkg/c.py': 'Z = 1\n',
  });
  assert.equal(find(g, 'pkg/a.py', 'pkg/b.py').length, 1);
  assert.equal(find(g, 'pkg/a.py', 'pkg/c.py').length, 1);
});

test('a relative import that climbs above the root is reported, not guessed at', () => {
  const g = analyse({ 'pkg/__init__.py': '', 'pkg/a.py': 'from ... import thing\n' });
  assert.equal(g.unresolved.length, 1);
  assert.match(g.unresolved[0].reason, /above the analysed root/);
});

test('importing a.b.c runs the __init__ of a and of a.b', () => {
  const g = analyse({
    'caller.py': 'import a.b.c\n',
    'a/__init__.py': '',
    'a/b/__init__.py': '',
    'a/b/c.py': 'X = 1\n',
  });
  assert.equal(find(g, 'caller.py', 'a/__init__.py')[0].kind, 'package-init');
  assert.equal(find(g, 'caller.py', 'a/b/__init__.py')[0].kind, 'package-init');
  assert.equal(find(g, 'caller.py', 'a/b/c.py').length, 1);
});

test('a module does not get an edge to its own package, because the parent loads first', () => {
  const g = analyse({
    'pkg/__init__.py': 'from pkg.a import X\n',
    'pkg/a.py': 'import pkg\nfrom pkg.b import Y\n\nX = 1\n',
    'pkg/b.py': 'Y = 2\n',
  });
  assert.equal(find(g, 'pkg/a.py', 'pkg/__init__.py').length, 0);
  assert.ok(g.ancestorEdgesSuppressed >= 2);
  assert.equal(find(g, 'pkg/a.py', 'pkg/b.py').length, 1);
});

test('reading a NAME out of your own package is still an edge, and still dangerous', () => {
  const g = analyse({
    'pkg/__init__.py': 'from pkg.a import X\n\nSHARED = 1\n',
    'pkg/a.py': 'from pkg import SHARED\n\nX = SHARED\n',
  });
  const e = find(g, 'pkg/a.py', 'pkg/__init__.py')[0];
  assert.equal(e.kind, 'from-name');
  assert.equal(e.needsBinding, true);
  assert.equal(e.executes, false, 'reading from the parent does not run the parent');
});

test('one import statement with many names is one edge', () => {
  const g = analyse({
    'a.py': 'from c import (ONE, TWO, THREE, FOUR)\n',
    'c.py': 'ONE = TWO = THREE = FOUR = 1\n',
  });
  assert.equal(find(g, 'a.py', 'c.py').length, 1);
  assert.deepEqual(find(g, 'a.py', 'c.py')[0].names, ['ONE', 'TWO', 'THREE', 'FOUR']);
});

test('from pkg import submodule is a submodule edge, not a name edge', () => {
  const g = analyse({
    'pkg/__init__.py': '',
    'pkg/sub.py': 'X = 1\n',
    'caller.py': 'from pkg import sub\n',
  });
  const e = find(g, 'caller.py', 'pkg/sub.py')[0];
  assert.equal(e.kind, 'from-submodule');
  assert.equal(e.needsBinding, false);
});

test('module level bindings record the line they first appear on', () => {
  const g = analyse({
    'a.py': 'EARLY = 1\n\n\ndef later():\n    pass\n\n\nclass Klass:\n    pass\n',
  });
  assert.equal(g.bindings['a.py'].EARLY.line, 1);
  assert.equal(g.bindings['a.py'].later.line, 4);
  assert.equal(g.bindings['a.py'].Klass.line, 8);
});

test('a binding inside a try is marked conditional, because it may never happen', () => {
  const g = analyse({ 'a.py': 'try:\n    MAYBE = 1\nexcept Exception:\n    pass\n' });
  assert.equal(g.bindings['a.py'].MAYBE.conditional, true);
});

test('module names get the root package prefix when the root is itself a package', () => {
  const dir = tree({
    'thing/__init__.py': '',
    'thing/inner/__init__.py': '',
    'thing/inner/leaf.py': '',
  });
  try {
    const { byId } = moduleNames(join(dir, 'thing'), [
      join(dir, 'thing', '__init__.py'),
      join(dir, 'thing', 'inner', '__init__.py'),
      join(dir, 'thing', 'inner', 'leaf.py'),
    ]);
    assert.equal(byId.get('inner/leaf.py').dotted, 'thing.inner.leaf');
    assert.equal(byId.get('__init__.py').dotted, 'thing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isAncestorPackage only matches whole segments', () => {
  assert.equal(isAncestorPackage('pkg.sub', 'pkg'), true);
  assert.equal(isAncestorPackage('pkg', 'pkg'), true);
  assert.equal(isAncestorPackage('pkgother', 'pkg'), false);
  assert.equal(isAncestorPackage('other.pkg', 'pkg'), false);
  assert.equal(isAncestorPackage('', 'pkg'), false);
});

test('imports of things outside the tree are counted, not reported as unknown', () => {
  const g = analyse({ 'a.py': 'import os\nimport json\nfrom collections import OrderedDict\n' });
  assert.equal(g.edges.length, 0);
  assert.equal(g.unresolved.length, 0, 'the standard library is not an incomplete graph');
  assert.equal(g.externalCount, 3);
});
