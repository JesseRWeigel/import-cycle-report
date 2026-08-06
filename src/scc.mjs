/* Strongly connected components.
 *
 * The reason this is Tarjan and not "find the back edges in a DFS tree" is that a back edge tells
 * you a cycle exists through the current tree path, and which path that is depends on the order
 * you happened to visit the nodes in. A three module cycle A -> B -> C -> A gets reported as
 * (C, A), or (A, B), or (B, C) depending only on where the walk started. Strongly connected
 * components are a property of the graph, so they come out the same no matter how the adjacency
 * lists are ordered, which is what makes a report comparable across runs.
 *
 * The recursion is written out by hand. A real dependency graph can be tens of thousands of
 * modules deep in a chain, and a recursive Tarjan blows the JS stack somewhere around 10k frames.
 */

/** Build an adjacency map. Every node in `nodes` appears, even with no edges. */
export function adjacency(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
  }
  return adj;
}

/**
 * Tarjan's algorithm, iterative.
 * Returns an array of components, each an array of node ids. Every node appears in exactly one.
 */
export function tarjanSCC(nodes, edges) {
  const adj = adjacency(nodes, edges);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let counter = 0;

  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    /** each frame is [node, next neighbour offset] */
    const work = [[root, 0]];

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame[0];
      const neighbours = adj.get(v);
      if (frame[1] < neighbours.length) {
        const w = neighbours[frame[1]];
        frame[1] += 1;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          comp.push(w);
          if (w === v) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}

/**
 * The same components, in a canonical form: members sorted, components sorted by size then by
 * first member. Two runs over the same graph produce byte identical output, whatever order the
 * files were read in.
 */
export function canonicalComponents(nodes, edges) {
  const comps = tarjanSCC(nodes, edges).map((c) => [...c].sort());
  comps.sort((a, b) => (b.length - a.length) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return comps;
}

/** Node ids that have an edge to themselves. A module importing itself is a cycle of length 1. */
export function selfLoops(edges) {
  const s = new Set();
  for (const e of edges) if (e.from === e.to) s.add(e.from);
  return s;
}

/**
 * The components that actually represent a cycle: more than one member, or a single member with
 * an edge to itself. A lone node with no self edge is strongly connected to itself trivially and
 * is not interesting.
 */
export function cyclicComponents(nodes, edges) {
  const loops = selfLoops(edges);
  return canonicalComponents(nodes, edges).filter((c) => c.length > 1 || loops.has(c[0]));
}

/** True when the graph has no cycle at all. */
export function isAcyclic(nodes, edges) {
  return cyclicComponents(nodes, edges).length === 0;
}

/** A stable fingerprint of a component set, for comparing two runs. */
export function componentsFingerprint(comps) {
  return comps
    .map((c) => [...c].sort().join(','))
    .sort()
    .join('|');
}
