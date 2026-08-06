/* Put the pieces together: build the graph, find the components, rank them, say how to break them.
 *
 * The ranking is the point of this tool. A dependency checker that flags every cycle equally gets
 * a "cycles: 47" badge, an argument, and then a config line turning it off. The four levels here
 * are ordered by whether the cycle can actually bite:
 *
 *   breaks    Every edge runs at import time AND at least one of them needs a name out of a module
 *             that is still halfway through loading. This is the one that raises ImportError on
 *             startup, or hands you `undefined` in JavaScript.
 *
 *   fragile   Every edge runs at import time, and none of them needs a name yet. Python is fine
 *             with this: `import a` binds a module object that exists from the first line. It
 *             stays fine until somebody adds one top level use of that module, at which point it
 *             becomes `breaks` with no other change. Worth knowing about, not worth an alarm.
 *
 *   lazy      The cycle only closes through an import inside a function, or a dynamic import().
 *             Module evaluation never goes round the loop. This is the standard, deliberate way
 *             to keep a cycle from mattering, and flagging it as a defect is how tools get muted.
 *
 *   types     The cycle only closes through an import that the compiler erases. There is no such
 *             cycle in the emitted JavaScript, and none at Python runtime either.
 */

import { cyclicComponents } from './scc.mjs';
import { feedbackArcSet } from './fas.mjs';
import { pythonGraph } from './python.mjs';
import { typescriptGraph } from './typescript.mjs';
import { walk, PY_EXT, TS_EXT } from './scan.mjs';

export const SEVERITY_ORDER = ['breaks', 'fragile', 'lazy', 'types'];
export const SEVERITY_RANK = { breaks: 3, fragile: 2, lazy: 1, types: 0 };

const within = (edges, set) => edges.filter((e) => set.has(e.from) && set.has(e.to));

function adviceFor(arc) {
  const kinds = new Set(arc.statements.map((s) => s.kind));
  if (kinds.has('from-name') || kinds.has('from-star')) {
    return 'move this import inside the function that uses it, or import the module and reach for the name later';
  }
  if (kinds.has('import') || kinds.has('importlib') || kinds.has('import-equals')) {
    return 'the module object itself is fine; the risk is the use at module level, so move that use into a function';
  }
  if (kinds.has('require')) {
    return 'require() copies whatever is exported right now; move it into the function that needs it';
  }
  if (kinds.has('re-export')) {
    return 'a barrel file re-exporting into a cycle is usually the easiest edge to delete: import from the real module instead';
  }
  if (kinds.has('package-init') || kinds.has('from-submodule')) {
    return 'the package __init__ pulls this in; import the submodule directly and take it out of __init__';
  }
  if (kinds.has('side-effect')) {
    return 'a bare side effect import still runs the module; move the side effect to an explicit call';
  }
  if (kinds.has('dynamic-import')) {
    return 'already deferred, so this edge is not what makes the cycle run';
  }
  return 'defer this import, or invert the dependency so the arrow points the other way';
}

function describe(severity, nodes, edges) {
  const n = nodes.length;
  const what = n === 1 ? 'a module imports itself' : `${n} modules import each other in a loop`;
  if (severity === 'breaks') {
    const culprit = edges.find((e) => e.needsBinding);
    return `${what}, and ${culprit ? `\`${culprit.from}\` line ${culprit.line} ` : ''}needs a name from a module that is still loading. This is the shape that raises an error at import.`;
  }
  if (severity === 'fragile') {
    return `${what} at import time, but nothing reads a name across the loop yet, so it runs today. One top level use of any of these imports turns it into a hard failure.`;
  }
  if (severity === 'lazy') {
    return `${what}, but the loop only closes through an import that runs later, so module evaluation never goes round it.`;
  }
  return `${what} only through imports the compiler erases. There is no cycle in the emitted code.`;
}

/** Analyse one already built graph. Exported separately so tests can feed synthetic graphs in. */
export function analyzeGraph(nodes, allEdges, opts = {}) {
  const runtimeEdges = allEdges.filter((e) => e.timing === 'import-time');
  const codeEdges = allEdges.filter((e) => e.timing !== 'erased');
  const structural = cyclicComponents(nodes, allEdges);
  const cycles = [];

  for (const comp of structural) {
    const set = new Set(comp);
    const compRuntime = within(runtimeEdges, set);
    const cores = cyclicComponents(comp, compRuntime);
    if (cores.length > 0) {
      for (const core of cores) {
        const coreSet = new Set(core);
        const coreEdges = within(compRuntime, coreSet);
        const severity = coreEdges.some((e) => e.needsBinding) ? 'breaks' : 'fragile';
        cycles.push(makeCycle(severity, core, coreEdges, comp.length, opts));
      }
      continue;
    }
    const compCode = within(codeEdges, set);
    const lazyCores = cyclicComponents(comp, compCode);
    if (lazyCores.length > 0) {
      for (const core of lazyCores) {
        const coreSet = new Set(core);
        cycles.push(makeCycle('lazy', core, within(compCode, coreSet), comp.length, opts));
      }
      continue;
    }
    cycles.push(makeCycle('types', comp, within(allEdges, set), comp.length, opts));
  }

  cycles.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.nodes.length - b.nodes.length ||
      (a.nodes[0] < b.nodes[0] ? -1 : a.nodes[0] > b.nodes[0] ? 1 : 0),
  );
  cycles.forEach((c, i) => {
    c.id = i + 1;
  });
  return cycles;
}

function makeCycle(severity, nodes, edges, structuralSize, opts) {
  const fas = feedbackArcSet(nodes, edges, opts.fas);
  return {
    id: 0,
    severity,
    nodes: [...nodes].sort(),
    structuralSize,
    edges: edges
      .map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        timing: e.timing,
        needsBinding: e.needsBinding,
        line: e.line,
        language: e.language,
        conditional: Boolean(e.conditional),
        detail: e.detail,
        text: e.text,
      }))
      .sort(
        (a, b) =>
          (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
          (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
          a.line - b.line,
      ),
    why: describe(severity, nodes, edges),
    break: {
      method: fas.method,
      proven: fas.proven,
      searched: fas.searched,
      arcs: fas.arcs.map((a) => ({
        from: a.from,
        to: a.to,
        statements: a.statements.map((s) => ({
          line: s.line,
          kind: s.kind,
          timing: s.timing,
          text: s.text,
          detail: s.detail,
        })),
        advice: adviceFor(a),
      })),
    },
  };
}

/**
 * Scan a directory and produce the whole report object.
 *
 * `label` is what the report calls the tree. It never contains an absolute path, because these
 * reports get attached to CI runs and emailed, and the directory layout of the machine that ran
 * the scan is nobody else's business.
 */
export function analyzeTree(root, opts = {}) {
  const lang = opts.lang || 'both';
  const ignores = opts.ignores;
  const parts = [];
  const unresolved = [];
  const parseErrors = [];
  let externalCount = 0;
  const counts = { python: 0, typescript: 0 };

  if (lang === 'py' || lang === 'both') {
    const files = walk(root, PY_EXT, ignores);
    counts.python = files.length;
    if (files.length > 0) {
      const g = pythonGraph(root, { files, ignores, python: opts.python });
      parts.push(g);
      unresolved.push(...g.unresolved);
      parseErrors.push(...g.parseErrors);
      externalCount += g.externalCount;
    }
  }
  if (lang === 'ts' || lang === 'both') {
    const files = walk(root, TS_EXT, ignores);
    counts.typescript = files.length;
    if (files.length > 0) {
      const g = typescriptGraph(root, { files, ignores, includeDeclarations: opts.includeDeclarations });
      parts.push(g);
      unresolved.push(...g.unresolved);
      parseErrors.push(...g.parseErrors);
      externalCount += g.externalCount;
    }
  }

  const nodes = [...new Set(parts.flatMap((p) => p.nodes))].sort();
  const edges = parts.flatMap((p) => p.edges);
  const cycles = analyzeGraph(nodes, edges, opts);

  const byTiming = { 'import-time': 0, deferred: 0, erased: 0 };
  for (const e of edges) byTiming[e.timing] = (byTiming[e.timing] || 0) + 1;

  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const c of cycles) bySeverity[c.severity] += 1;

  return {
    tool: { name: 'import-cycle-report', version: opts.version || '0.0.0' },
    label: opts.label || 'source tree',
    languages: counts,
    totals: {
      modules: nodes.length,
      edges: edges.length,
      importTimeEdges: byTiming['import-time'] || 0,
      deferredEdges: byTiming.deferred || 0,
      erasedEdges: byTiming.erased || 0,
      externalImportsIgnored: externalCount,
      cycles: cycles.length,
      modulesInCycles: new Set(cycles.flatMap((c) => c.nodes)).size,
    },
    bySeverity,
    complete: unresolved.length === 0 && parseErrors.length === 0,
    unresolved: unresolved.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
    parseErrors: parseErrors.sort((a, b) => (a.file < b.file ? -1 : 1)),
    cycles,
    graph: opts.includeGraph ? { nodes, edges } : undefined,
  };
}

/** Highest severity present, or null for a clean tree. */
export function worstSeverity(report) {
  for (const s of SEVERITY_ORDER) if (report.bySeverity[s] > 0) return s;
  return null;
}
