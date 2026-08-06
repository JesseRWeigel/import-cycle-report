import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclicComponents, canonicalComponents, isAcyclic } from '../src/scc.mjs';
import {
  asEdges,
  fingerprint,
  loadGraphFixtures,
  oracleComponents,
  shuffled,
} from './helpers.mjs';

const graphs = loadGraphFixtures();

test('the fixture set contains negative controls', () => {
  const clean = graphs.filter((g) => g.components.length === 0);
  assert.ok(
    clean.length >= 4,
    `only ${clean.length} acyclic fixtures. Without several, a detector that reports a cycle in ` +
      'everything passes the whole suite by finding the planted ones.',
  );
});

for (const g of graphs) {
  test(`components match the hand written answer: ${g.name}`, () => {
    const got = cyclicComponents(g.nodes, asEdges(g.edges));
    assert.deepEqual(got, g.components.map((c) => [...c].sort()), g.why);
  });

  test(`components match an independent oracle: ${g.name}`, () => {
    const got = cyclicComponents(g.nodes, asEdges(g.edges));
    assert.deepEqual(got, oracleComponents(g.nodes, g.edges), g.why);
  });

  test(`the answer does not depend on ordering: ${g.name}`, () => {
    const base = fingerprint(cyclicComponents(g.nodes, asEdges(g.edges)));
    for (let seed = 1; seed <= 40; seed += 1) {
      const nodes = shuffled(g.nodes, seed);
      const edges = shuffled(g.edges, seed * 7919);
      const got = fingerprint(cyclicComponents(nodes, asEdges(edges)));
      assert.equal(
        got,
        base,
        `seed ${seed} changed the answer for ${g.name}. This is the failure a DFS back edge ` +
          'check produces: the cycle it names depends on where the walk started.',
      );
    }
  });

  test(`acyclicity agrees with the component count: ${g.name}`, () => {
    assert.equal(isAcyclic(g.nodes, asEdges(g.edges)), g.components.length === 0);
  });
}

test('every node lands in exactly one component', () => {
  for (const g of graphs) {
    const comps = canonicalComponents(g.nodes, asEdges(g.edges));
    const seen = comps.flat();
    assert.equal(seen.length, new Set(seen).size, `${g.name} put a node in two components`);
    assert.deepEqual([...seen].sort(), [...g.nodes].sort(), `${g.name} lost or invented a node`);
  }
});

test('a deep chain does not blow the stack', () => {
  // A recursive Tarjan dies somewhere around ten thousand frames. Real trees get this deep.
  const n = 60000;
  const nodes = Array.from({ length: n }, (_, i) => `m${i}`);
  const pairs = [];
  for (let i = 0; i < n - 1; i += 1) pairs.push([`m${i}`, `m${i + 1}`]);
  pairs.push([`m${n - 1}`, `m${n - 3}`]);
  const comps = cyclicComponents(nodes, asEdges(pairs));
  assert.deepEqual(comps, [[`m${n - 3}`, `m${n - 2}`, `m${n - 1}`]]);
});

test('edges to nodes not in the node list still count', () => {
  // A resolver can hand back an edge whose endpoint was filtered out of the file list.
  const comps = cyclicComponents(['a'], asEdges([['a', 'ghost'], ['ghost', 'a']]));
  assert.deepEqual(comps, [['a', 'ghost']]);
});

test('a random graph agrees with the oracle a hundred times over', () => {
  // The hand written fixtures cover the shapes somebody thought of. This covers the rest.
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let withCycles = 0;
  for (let round = 0; round < 100; round += 1) {
    const n = 3 + Math.floor(rnd() * 9);
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const pairs = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (rnd() < 0.18) pairs.push([`n${i}`, `n${j}`]);
      }
    }
    const got = cyclicComponents(nodes, asEdges(pairs));
    assert.deepEqual(got, oracleComponents(nodes, pairs), `round ${round} disagreed`);
    if (got.length > 0) withCycles += 1;
  }
  assert.ok(withCycles > 20, `only ${withCycles} of 100 random graphs had a cycle, too few to test`);
  assert.ok(withCycles < 100, 'every random graph had a cycle, so the negative path was untested');
});
