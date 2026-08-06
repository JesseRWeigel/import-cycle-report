/* Test helpers, including an SCC oracle that shares no code with the implementation. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'fixtures');

export function loadGraphFixtures() {
  return JSON.parse(readFileSync(join(FIXTURES, 'graphs.json'), 'utf8')).graphs;
}

export function loadTreeExpectations() {
  return JSON.parse(readFileSync(join(FIXTURES, 'trees', 'expected.json'), 'utf8'));
}

/** Turn [from, to] pairs into the edge objects the implementation expects. */
export function asEdges(pairs, extra = {}) {
  return pairs.map(([from, to], i) => ({
    from,
    to,
    line: i + 1,
    timing: 'import-time',
    kind: 'import',
    needsBinding: false,
    ...extra,
  }));
}

/**
 * Components computed the slow, obvious way: build the full reachability relation, then put u and
 * v together when u reaches v and v reaches u. That is the DEFINITION of strongly connected, so
 * it cannot share a bug with Tarjan. It is cubic and only usable on small graphs, which is exactly
 * what a test needs.
 */
export function oracleComponents(nodes, pairs) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const n = nodes.length;
  const reach = Array.from({ length: n }, () => new Array(n).fill(false));
  for (const [a, b] of pairs) {
    if (idx.has(a) && idx.has(b)) reach[idx.get(a)][idx.get(b)] = true;
  }
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      if (!reach[i][k]) continue;
      for (let j = 0; j < n; j += 1) {
        if (reach[k][j]) reach[i][j] = true;
      }
    }
  }
  const seen = new Set();
  const comps = [];
  for (let i = 0; i < n; i += 1) {
    if (seen.has(i)) continue;
    const group = [nodes[i]];
    seen.add(i);
    for (let j = i + 1; j < n; j += 1) {
      if (!seen.has(j) && reach[i][j] && reach[j][i]) {
        group.push(nodes[j]);
        seen.add(j);
      }
    }
    const isCycle = group.length > 1 || reach[i][i];
    if (isCycle) comps.push(group.sort());
  }
  comps.sort((a, b) => (b.length - a.length) || (a[0] < b[0] ? -1 : 1));
  return comps;
}

/** A deterministic shuffle, so a failing ordering can be reproduced from the seed. */
export function shuffled(arr, seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function fingerprint(comps) {
  return comps
    .map((c) => [...c].sort().join(','))
    .sort()
    .join('|');
}
