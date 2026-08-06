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
import { dirname, join, resolve } from 'node:path';
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
 */
export function moduleNames(root, absPaths) {
  const byDotted = new Map();
  const byId = new Map();
  const hasInit = new Map();
  const dirIsPackage = (dir) => {
    if (!hasInit.has(dir)) hasInit.set(dir, isFile(join(dir, '__init__.py')));
    return hasInit.get(dir);
  };
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
    const dotted = stem === '__init__' ? chain.join('.') : [...chain, stem].join('.');
    if (!dotted) continue;
    if (!byDotted.has(dotted) || byDotted.get(dotted).length > id.length) byDotted.set(dotted, id);
    byId.set(id, { dotted, isPackage: stem === '__init__', pkg: stem === '__init__' ? dotted : chain.join('.') });
  }
  return { byDotted, byId };
}

function pushEdge(edges, e) {
  if (!e.to || e.to === undefined) return;
  edges.push(e);
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
  const unresolved = [];
  const parseErrors = [];
  let externalCount = 0;

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
        text: imp.text,
      };

      // Every package along the way is imported for real.
      const parts = base ? base.split('.') : [];
      for (let i = 1; i < parts.length; i += 1) {
        const parentId = resolveDotted(parts.slice(0, i).join('.'));
        if (parentId && parentId !== id) {
          pushEdge(edges, {
            ...common,
            to: parentId,
            kind: 'package-init',
            needsBinding: false,
            detail: `importing ${base} runs ${parts.slice(0, i).join('.')}/__init__.py first`,
          });
        }
      }

      const targetId = resolveDotted(base);

      if (imp.kind === 'from') {
        // `from a import b`: b may be a submodule (safe) or a name in a/__init__.py (not safe).
        let anyName = false;
        for (const n of imp.names) {
          const subId = resolveDotted(base ? `${base}.${n.name}` : n.name);
          if (subId) {
            anyName = true;
            if (subId !== id) {
              pushEdge(edges, {
                ...common,
                to: subId,
                kind: 'from-submodule',
                needsBinding: false,
                detail: `${n.name} resolves to a submodule, so the module object exists before its body runs`,
              });
            }
            if (targetId && targetId !== id) {
              pushEdge(edges, {
                ...common,
                to: targetId,
                kind: 'package-init',
                needsBinding: false,
                detail: `importing the submodule runs ${base}/__init__.py first`,
              });
            }
          } else if (targetId) {
            anyName = true;
            if (targetId !== id) {
              pushEdge(edges, {
                ...common,
                to: targetId,
                kind: 'from-name',
                needsBinding: true,
                detail: `needs the name ${n.name} to already exist in ${base}`,
              });
            }
          }
        }
        if (imp.star && targetId && targetId !== id) {
          anyName = true;
          pushEdge(edges, {
            ...common,
            to: targetId,
            kind: 'from-star',
            needsBinding: true,
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
      pushEdge(edges, {
        ...common,
        to: targetId,
        kind: imp.kind === 'importlib' ? 'importlib' : 'import',
        needsBinding: Boolean(imp.needs_binding),
        detail: imp.needs_binding
          ? imp.binding_reason || 'the bound name is used while the module body runs'
          : 'binds the module object, which exists before the module body finishes',
      });
    }
  }

  return { nodes, edges, unresolved, parseErrors, externalCount, moduleNames: byId };
}
