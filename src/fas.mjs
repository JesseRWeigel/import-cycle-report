/* Which edges to delete to break a cycle.
 *
 * This is the minimum feedback arc set problem, and it is NP-hard (Karp 1972, one of the original
 * 21). There is no algorithm here that finds the true minimum on a large component in reasonable
 * time, and any tool that implies otherwise is lying to you.
 *
 * So this does two different things depending on size, and says which one it did:
 *
 *   Small components get an EXHAUSTIVE search. Try every single edge, then every pair, and so on,
 *   stopping at the first size that works. That answer is provably minimum, and most real cycles
 *   are small enough for it: a 3 module cycle has 3 edges and 3 subsets to test at size 1.
 *
 *   Large components get the Eades, Lin and Smyth GR heuristic (1993), which orders the vertices
 *   greedily and calls every backward edge a feedback edge. GR guarantees a feedback set no larger
 *   than m/2 - n/6 for a graph with n vertices and m edges, which is a bound and not optimality.
 *   The result is then reduced: any edge that can be added back without recreating a cycle is
 *   dropped, so the answer is at least minimal (no proper subset works) even when it is not
 *   minimum (no smaller set anywhere works).
 *
 * Parallel edges collapse. Two `import` statements from the same file to the same file are one arc
 * as far as the graph is concerned, and breaking it means dealing with both statements.
 */

import { isAcyclic } from './scc.mjs';

/** Collapse an edge list to unique from,to pairs, keeping the statements behind each. */
export function uniqueArcs(edges) {
  const byKey = new Map();
  for (const e of edges) {
    const key = `${e.from}${e.to}`;
    if (!byKey.has(key)) byKey.set(key, { from: e.from, to: e.to, statements: [] });
    byKey.get(key).statements.push(e);
  }
  return [...byKey.values()].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
}

function acyclicWithout(nodes, arcs, removedIdx) {
  const kept = [];
  for (let i = 0; i < arcs.length; i += 1) if (!removedIdx.has(i)) kept.push(arcs[i]);
  return isAcyclic(nodes, kept);
}

/** Iterate every k sized subset of [0..n) and call fn with a Set. Stops early if fn returns true. */
function forEachSubset(n, k, budget, fn) {
  const idx = [];
  for (let i = 0; i < k; i += 1) idx.push(i);
  let used = 0;
  for (;;) {
    used += 1;
    if (used > budget) return { found: null, used, exhausted: false };
    if (fn(new Set(idx))) return { found: [...idx], used, exhausted: true };
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return { found: null, used, exhausted: true };
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

/** Eades, Lin and Smyth GR: greedy linear arrangement, then every backward arc is feedback. */
export function greedyOrdering(nodes, arcs) {
  const outAdj = new Map();
  const inAdj = new Map();
  for (const n of nodes) {
    outAdj.set(n, new Set());
    inAdj.set(n, new Set());
  }
  for (const a of arcs) {
    if (a.from === a.to) continue;
    outAdj.get(a.from).add(a.to);
    inAdj.get(a.to).add(a.from);
  }
  const remaining = new Set(nodes);
  const s1 = [];
  const s2 = [];
  const outDeg = (v) => [...outAdj.get(v)].filter((w) => remaining.has(w)).length;
  const inDeg = (v) => [...inAdj.get(v)].filter((w) => remaining.has(w)).length;

  while (remaining.size > 0) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const v of [...remaining].sort()) {
        if (outDeg(v) === 0) {
          remaining.delete(v);
          s2.unshift(v);
          moved = true;
        }
      }
      for (const v of [...remaining].sort()) {
        if (remaining.has(v) && inDeg(v) === 0) {
          remaining.delete(v);
          s1.push(v);
          moved = true;
        }
      }
    }
    if (remaining.size === 0) break;
    // Ties break on the node id so the ordering does not depend on iteration order.
    let best = null;
    let bestScore = -Infinity;
    for (const v of [...remaining].sort()) {
      const score = outDeg(v) - inDeg(v);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    remaining.delete(best);
    s1.push(best);
  }
  return [...s1, ...s2];
}

/**
 * Find a set of arcs whose removal makes the component acyclic.
 *
 * Returns { arcs, method, proven, searched }. `proven` is true only when the search was
 * exhaustive at every smaller size, so no smaller set exists.
 */
export function feedbackArcSet(nodes, edges, opts = {}) {
  const exactMaxArcs = opts.exactMaxArcs ?? 22;
  const budget = opts.budget ?? 400000;
  const arcs = uniqueArcs(edges).filter((a) => nodes.includes(a.from) && nodes.includes(a.to));

  if (isAcyclic(nodes, arcs)) {
    return { arcs: [], method: 'none-needed', proven: true, searched: 0 };
  }

  // Self loops must always go, and no reordering can help them.
  const selfIdx = new Set();
  arcs.forEach((a, i) => {
    if (a.from === a.to) selfIdx.add(i);
  });

  if (arcs.length <= exactMaxArcs) {
    let searched = 0;
    const maxK = arcs.length;
    for (let k = Math.max(1, selfIdx.size); k <= maxK; k += 1) {
      const res = forEachSubset(arcs.length, k, budget - searched, (set) => {
        for (const s of selfIdx) if (!set.has(s)) return false;
        return acyclicWithout(nodes, arcs, set);
      });
      searched += res.used;
      if (res.found) {
        return {
          arcs: res.found.map((i) => arcs[i]),
          method: 'exact-exhaustive',
          proven: true,
          searched,
        };
      }
      if (!res.exhausted) break; // ran out of budget, fall through to the heuristic
    }
  }

  const order = greedyOrdering(nodes, arcs);
  const pos = new Map(order.map((n, i) => [n, i]));
  const candidate = new Set();
  arcs.forEach((a, i) => {
    if (a.from === a.to || pos.get(a.from) >= pos.get(a.to)) candidate.add(i);
  });
  // Reduce to a minimal set: put each arc back and keep it out only if it is still needed.
  for (const i of [...candidate].sort((a, b) => a - b)) {
    if (selfIdx.has(i)) continue;
    const trial = new Set(candidate);
    trial.delete(i);
    if (acyclicWithout(nodes, arcs, trial)) candidate.delete(i);
  }
  return {
    arcs: [...candidate].sort((a, b) => a - b).map((i) => arcs[i]),
    method: 'heuristic-eades-lin-smyth',
    proven: false,
    searched: 0,
  };
}
