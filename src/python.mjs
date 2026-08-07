/* Turn a Python tree into a module graph.
 *
 * Parsing happens in src/py_extract.py, because Python's own `ast` module is the only parser that
 * agrees with Python. Resolution happens here, and it is the part that is easy to get wrong:
 *
 *   `import a.b.c` does not create one edge. Python imports `a`, then `a.b`, then `a.b.c`, so
 *   every package __init__ along the way runs. A package whose __init__ imports a submodule that
 *   imports the package is the single most common real Python cycle, and a resolver that only
 *   records the deepest target cannot see it at all.
 *
 *   `from a import b` is ambiguous in the source and unambiguous on disk. If `a/b.py` exists it is
 *   a submodule import, which is safe in a cycle because the module object is created before its
 *   body runs. If it does not, `b` is a name inside `a/__init__.py`, which is not safe, because
 *   the name may not have been assigned yet.
 *
 * Anything that does not resolve to a file inside the tree is external: the standard library, a
 * site-packages dependency, a namespace package elsewhere. Those are dropped, and counted, rather
 * than reported as unknown, because "this project does not contain `os`" is not a finding.
 */

import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFile, toId, walk, PY_EXT } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run the ast extractor over a list of absolute paths. Throws when Python is not usable. */
export function runExtractor(paths, python = process.env.PYTHON || 'python3') {
  if (paths.length === 0) return { files: {} };
  const script = join(HERE, 'py_extract.py');
  const res = spawnSync(python, [script], {
    input: paths.join('\0'),
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'utf8',
  });
  if (res.error) {
    throw new Error(
      `could not run ${python}: ${res.error.message}. Python 3.8 or newer is required to ` +
        `analyse Python files. Install it, or pass --lang ts to analyse only TypeScript.`,
    );
  }
  if (res.status !== 0) {
    throw new Error(`${python} ${script} exited ${res.status}: ${(res.stderr || '').slice(0, 400)}`);
  }
  return JSON.parse(res.stdout);
}

/**
 * Map every file to a dotted module name. The source root for a file is the first ancestor
 * directory that is not itself a package, which is what would be on sys.path.
 *
 * When the analysed root IS a package, that root is above sys.path, not on it. Point this at
 * site-packages/twisted and the file internet/tcp.py is `twisted.internet.tcp` to every import
 * statement inside the tree, so the root's own name has to go back on the front. Without this the
 * whole graph comes out empty and the tool reports a large library as having no cycles, which is
 * the worst possible failure for something advisory.
 */
export function moduleNames(root, absPaths) {
  const byDotted = new Map();
  const byId = new Map();
  const hasInit = new Map();
  const dirIsPackage = (dir) => {
    if (!hasInit.has(dir)) hasInit.set(dir, isFile(join(dir, '__init__.py')));
    return hasInit.get(dir);
  };
  const rootPrefix = dirIsPackage(root) ? basename(root) : '';
  for (const abs of absPaths) {
    const id = toId(root, abs);
    const parts = id.split('/');
    const file = parts[parts.length - 1];
    const stem = file.replace(/\.pyi?$/, '');
    let dirParts = parts.slice(0, -1);
    // Climb while the directory is a package, collecting the package chain.
    const chain = [];
    let cursor = [...dirParts];
    while (cursor.length > 0 && dirIsPackage(join(root, ...cursor))) {
      chain.unshift(cursor[cursor.length - 1]);
      cursor = cursor.slice(0, -1);
    }
    const prefix = rootPrefix ? [rootPrefix] : [];
    const dotted =
      stem === '__init__'
        ? [...prefix, ...chain].join('.')
        : [...prefix, ...chain, stem].join('.');
    if (!dotted) continue;
    if (!byDotted.has(dotted) || byDotted.get(dotted).length > id.length) byDotted.set(dotted, id);
    byId.set(id, {
      dotted,
      isPackage: stem === '__init__',
      pkg: stem === '__init__' ? dotted : [...prefix, ...chain].join('.'),
    });
  }
  return { byDotted, byId };
}

function pushEdge(edges, e) {
  if (!e.to || e.to === undefined) return;
  if (e.mainGuard) {
    e.detail = `${e.detail} This sits inside \`if __name__ == "__main__"\`, so it does not run when the module is imported.`;
  }
  delete e.mainGuard;
  edges.push(e);
}

/** Is `prefix` the package this file sits in, or one of that package's own parents. */
export function isAncestorPackage(selfPkg, prefix) {
  if (!selfPkg || !prefix) return false;
  return selfPkg === prefix || selfPkg.startsWith(`${prefix}.`);
}

/**
 * Build the Python part of the graph.
 * Returns { nodes, edges, unresolved, parseErrors, externalCount }.
 */
export function pythonGraph(root, opts = {}) {
  const absPaths = opts.files || walk(root, PY_EXT, opts.ignores);
  const extracted = runExtractor(absPaths, opts.python);
  const { byDotted, byId } = moduleNames(root, absPaths);

  const nodes = [];
  for (const abs of absPaths) {
    const id = toId(root, abs);
    if (byId.has(id)) nodes.push(id);
  }
  const nodeSet = new Set(nodes);
  const edges = [];
  /** fileId -> { name: {line, conditional} } for names bound while the module body runs. */
  const bindings = {};
  const unresolved = [];
  const parseErrors = [];
  let externalCount = 0;
  let ancestorEdgesSuppressed = 0;

  const resolveDotted = (dotted) => {
    if (!dotted) return null;
    const hit = byDotted.get(dotted);
    return hit && nodeSet.has(hit) ? hit : null;
  };

  for (const abs of absPaths) {
    const id = toId(root, abs);
    const info = extracted.files[abs];
    if (!info) continue;
    if (info.parse_error) {
      parseErrors.push({ file: id, language: 'python', message: info.parse_error });
      continue;
    }
    const self = byId.get(id);
    if (!self) continue;

    const table = {};
    for (const b of info.bindings || []) {
      const prev = table[b.name];
      // Keep the earliest binding, and prefer an unconditional one: a name assigned inside a
      // `try` may never be assigned at all, so it cannot be relied on to exist by any line.
      if (!prev || (prev.conditional && !b.conditional) || (prev.conditional === b.conditional && b.line < prev.line)) {
        table[b.name] = { line: b.line, conditional: b.conditional };
      }
    }
    bindings[id] = table;

    for (const d of info.dynamic) {
      unresolved.push({ file: id, language: 'python', line: d.line, reason: d.reason, text: d.text });
    }

    for (const imp of info.imports) {
      // Work out the absolute dotted target.
      let base = imp.module || '';
      if (imp.level > 0) {
        const pkgParts = self.pkg ? self.pkg.split('.') : [];
        const up = imp.level - 1;
        if (up > pkgParts.length) {
          unresolved.push({
            file: id,
            language: 'python',
            line: imp.line,
            reason: `relative import climbs ${imp.level} levels, above the analysed root`,
            text: imp.text,
          });
          continue;
        }
        const anchor = pkgParts.slice(0, pkgParts.length - up);
        base = [...anchor, ...(imp.module ? imp.module.split('.') : [])].join('.');
      }
      if (!base && imp.kind !== 'from') continue;

      const common = {
        from: id,
        language: 'python',
        line: imp.line,
        timing: imp.timing,
        conditional: imp.conditional,
        mainGuard: Boolean(imp.main_guard),
        text: imp.text,
      };

      // Every package along the way is imported for real, so `import a.b.c` runs a/__init__.py
      // and a/b/__init__.py before it runs a/b/c.py. Those are real edges and they cause real
      // cycles, EXCEPT when the package is one this file already lives inside.
      //
      // That exception matters more than it sounds. Python imports a parent package before any of
      // its children, and puts it in sys.modules before running its body, so by the time
      // chardet/charsetprober.py runs, `chardet` is already there. `from chardet.enums import X`
      // inside it cannot re-enter chardet/__init__.py. Counting that arrow anyway makes every
      // package on earth one strongly connected component: chardet came out as a single 32 module
      // cycle, urllib3 as 18, and every one of them was this artefact rather than a finding. A
      // report like that is exactly the one people switch off.
      //
      // The genuinely dangerous version of the same shape is `from chardet import SOMENAME`,
      // which needs a name out of a half finished __init__, and that is a from-name edge below.
      const parts = base ? base.split('.') : [];
      for (let i = 1; i < parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('.');
        const parentId = resolveDotted(prefix);
        if (!parentId || parentId === id) continue;
        if (isAncestorPackage(self.pkg, prefix)) {
          ancestorEdgesSuppressed += 1;
          continue;
        }
        pushEdge(edges, {
          ...common,
          to: parentId,
          kind: 'package-init',
          needsBinding: false,
          detail: `importing ${base} runs ${prefix}/__init__.py first`,
        });
      }

      const targetId = resolveDotted(base);

      if (imp.kind === 'from') {
        // `from a import b`: b may be a submodule (safe) or a name in a/__init__.py (not safe).
        // One statement is one edge per target, however many names it lists. Emitting an edge per
        // name turns `from x import (a, b, c, d, e, f, g)` into seven identical arrows in the
        // report, which is the same arrow said seven times.
        let anyName = false;
        const named = [];
        const submodules = [];
        for (const n of imp.names) {
          const subId = resolveDotted(base ? `${base}.${n.name}` : n.name);
          if (subId) {
            anyName = true;
            if (subId !== id) submodules.push({ subId, name: n.name });
          } else if (targetId) {
            anyName = true;
            named.push(n.name);
          }
        }
        const seenSub = new Set();
        for (const s of submodules) {
          if (seenSub.has(s.subId)) continue;
          seenSub.add(s.subId);
          const names = submodules.filter((x) => x.subId === s.subId).map((x) => x.name);
          pushEdge(edges, {
            ...common,
            to: s.subId,
            kind: 'from-submodule',
            needsBinding: false,
            detail: `${names.join(', ')} resolves to a submodule, so its module object exists before its body runs`,
          });
        }
        if (submodules.length > 0 && targetId && targetId !== id) {
          if (isAncestorPackage(self.pkg, base)) {
            ancestorEdgesSuppressed += 1;
          } else {
            pushEdge(edges, {
              ...common,
              to: targetId,
              kind: 'package-init',
              needsBinding: false,
              detail: `importing the submodule runs ${base}/__init__.py first`,
            });
          }
        }
        if (named.length > 0 && targetId !== id) {
          // A package __init__ reading a name out of its OWN submodule is not the statement that
          // raises. Python imports a parent package before any of its children, so the __init__ is
          // always the outermost frame for its own package: when it reaches this line the
          // submodule is either untouched or already finished, never halfway. The dangerous
          // direction is the other one, a submodule reading a name out of the __init__ that is
          // still running, and that is the same edge with `from` and `to` swapped.
          //
          // Without this, setuptools, cryptography and every other package whose __init__ is a
          // facade come out as breaking cycles, and they all import perfectly well.
          const ownSubmodule =
            self.isPackage && isAncestorPackage(byId.get(targetId)?.pkg, self.dotted);
          // `from pkg import NAME` inside pkg/sub.py reads a name off a package that is already
          // in sys.modules, so it can raise, but it does NOT run pkg/__init__.py: the parent is
          // loaded before any child. Recording "reads a name" and "transfers control" as one
          // property conflates the two, and the cost of that shows up in twisted._threads, where
          // the pool reads a class out of a sibling that can never call back into it.
          const executes = !isAncestorPackage(self.pkg, base);
          pushEdge(edges, {
            ...common,
            to: targetId,
            kind: 'from-name',
            names: named,
            executes,
            // The extractor decides whether a statement reads a name; this side decides whether
            // the target can be half built when it does. Recomputing the first half here as well
            // would give the field two sources of truth, and the copy nobody reads goes stale.
            needsBinding: Boolean(imp.needs_binding) && !ownSubmodule,
            detail: ownSubmodule
              ? `pulls ${named.join(', ')} out of its own submodule, which Python imports fresh at this point`
              : `needs ${named.length === 1 ? 'the name' : 'the names'} ${named.join(', ')} to already exist in ${base}`,
          });
        }
        if (imp.star && targetId && targetId !== id) {
          anyName = true;
          pushEdge(edges, {
            ...common,
            to: targetId,
            kind: 'from-star',
            names: null,
            executes: !isAncestorPackage(self.pkg, base),
            needsBinding: Boolean(imp.needs_binding),
            detail: `a star import copies the whole namespace of ${base} as it stands right now`,
          });
        }
        if (!anyName && !targetId) externalCount += 1;
        continue;
      }

      if (!targetId) {
        externalCount += 1;
        continue;
      }
      if (targetId === id) continue;
      // `import setuptools` inside setuptools/monkey.py cannot execute setuptools/__init__.py,
      // for the same reason the implicit parent edges above are dropped: the parent is in
      // sys.modules before any child body runs. It only becomes an edge when the module level
      // code reaches into that half built parent for an attribute, which needs_binding records.
      if (isAncestorPackage(self.pkg, base) && !imp.needs_binding) {
        ancestorEdgesSuppressed += 1;
        continue;
      }
      pushEdge(edges, {
        ...common,
        to: targetId,
        kind: imp.kind === 'importlib' ? 'importlib' : 'import',
        executes: !isAncestorPackage(self.pkg, base),
        needsBinding: Boolean(imp.needs_binding),
        detail: imp.needs_binding
          ? imp.binding_reason || 'the bound name is used while the module body runs'
          : 'binds the module object, which exists before the module body finishes',
      });
    }
  }

  return {
    nodes,
    edges,
    unresolved,
    parseErrors,
    externalCount,
    ancestorEdgesSuppressed,
    bindings,
    moduleNames: byId,
  };
}
