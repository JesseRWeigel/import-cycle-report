/* Turn a TypeScript or JavaScript tree into a module graph, using the TypeScript compiler's own
 * parser. Not a regex.
 *
 * The catalog entry for this task said ts-morph. ts-morph is a wrapper over exactly this API and
 * pulls the same compiler in as a dependency, so this uses `typescript` directly: one dependency
 * instead of two, and the syntax kinds below are the same ones ts-morph would be reading.
 *
 * What matters for cycles in TypeScript, and what a line based scan cannot tell you:
 *
 *   `import type { A } from './a'` is ERASED. It does not exist in the emitted JavaScript and it
 *   cannot cause a runtime cycle. Reporting it as one sends people to break a dependency that is
 *   not there.
 *
 *   `import { A } from './a'` where A is only ever used in a type position is ALSO erased, by
 *   default, because tsc elides imports with no value use. That changes under
 *   `verbatimModuleSyntax`, so it is labelled differently from an explicit `import type` and the
 *   report says so.
 *
 *   `import { thing } from './a'` where `thing` is called at the top level of the module is the
 *   dangerous one. ESM bindings are live, so a cycle is fine right up until somebody reads the
 *   binding before the other module has assigned it, and then it is undefined or a TDZ error.
 *   Using the same import inside a function body is fine forever.
 *
 *   `await import('./a')` is deferred and breaks the cycle at runtime. `import(name)` with a
 *   computed specifier cannot be resolved by any static tool, and this one says so by file and
 *   line rather than pretending the edge is not there.
 */

import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFile, toId, walk, TS_EXT } from './scan.mjs';

const require = createRequire(import.meta.url);

let tsCache = null;
export function loadTypeScript() {
  if (tsCache) return tsCache;
  try {
    tsCache = require('typescript');
  } catch (e) {
    throw new Error(
      'the `typescript` package is not installed, and it is the parser this tool uses for ' +
        '.ts/.tsx/.js files. Run `npm install` in the tool directory. Without it only Python ' +
        'analysis can run, and a partial graph is not a cycle report.',
    );
  }
  return tsCache;
}

const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

/** Resolve a relative specifier the way Node and tsc between them would. */
export function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const m = /(\.[cm]?jsx?)$/.exec(spec);
  if (m) {
    const stem = base.slice(0, base.length - m[1].length);
    for (const ext of JS_TO_TS[m[1]] || []) {
      if (isFile(stem + ext)) return stem + ext;
    }
  }
  if (isFile(base) && /\.[cm]?[tj]sx?$/.test(base)) return base;
  for (const ext of RESOLVE_EXT) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXT) {
    if (isFile(join(base, 'index' + ext))) return join(base, 'index' + ext);
  }
  return null;
}

/**
 * Which imported names are read as VALUES, and which of those are read while the module body is
 * running. Everything inside a type position is ignored, and everything inside a function body
 * counts as a value use but not as a module time use.
 */
function collectUses(ts, sf) {
  const valueUses = new Set();
  const moduleTimeUses = new Set();

  const isFunctionLike = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n);

  const visit = (node, evalNow) => {
    if (!node) return;
    // Type positions produce no JavaScript.
    if (
      ts.isTypeNode(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeParameterDeclaration(node)
    ) {
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;

    if (ts.isIdentifier(node)) {
      valueUses.add(node.text);
      if (evalNow) moduleTimeUses.add(node.text);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression, evalNow);
      return;
    }
    if (ts.isQualifiedName(node)) return;
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name, evalNow);
      visit(node.initializer, evalNow);
      return;
    }
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) return;
    if (ts.isBindingElement(node)) {
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
        visit(node.propertyName, evalNow);
      }
      visit(node.initializer, evalNow);
      // The bound names are declarations, not uses.
      if (node.name && !ts.isIdentifier(node.name)) visit(node.name, evalNow);
      return;
    }
    if (isFunctionLike(node)) {
      (ts.getDecorators?.(node) || []).forEach((d) => visit(d, evalNow));
      for (const p of node.parameters || []) {
        (ts.getDecorators?.(p) || []).forEach((d) => visit(d, evalNow));
        visit(p.initializer, evalNow);
      }
      visit(node.body, false);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // extends and decorators run when the class statement runs, so at module time for a top
      // level class. Method bodies and instance field initialisers do not.
      (ts.getDecorators?.(node) || []).forEach((d) => visit(d, evalNow));
      for (const h of node.heritageClauses || []) {
        if (h.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const t of h.types) visit(t.expression, evalNow);
        }
      }
      for (const member of node.members) {
        (ts.getDecorators?.(member) || []).forEach((d) => visit(d, evalNow));
        if (ts.isClassStaticBlockDeclaration(member)) {
          visit(member.body, evalNow);
          continue;
        }
        const isStatic = (ts.getModifiers?.(member) || []).some(
          (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
        );
        if (ts.isPropertyDeclaration(member)) {
          visit(member.initializer, isStatic ? evalNow : false);
          continue;
        }
        visit(member, false);
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, evalNow));
  };

  ts.forEachChild(sf, (n) => visit(n, true));
  return { valueUses, moduleTimeUses };
}

/**
 * Export names that are safe to read during a cycle because they are hoisted.
 *
 * `export function f() {}` is in scope from the first instruction of the module, so a partner
 * module can call it while this one is still evaluating. `export const f = () => {}` is not: it
 * sits in the temporal dead zone until its line runs, and reading it early throws. Same file,
 * same call site, opposite outcome, and the only difference is the keyword.
 */
function hoistedExportNames(ts, sf) {
  const hoisted = new Set();
  const localHoisted = new Set();
  const isExported = (n) =>
    (ts.getModifiers?.(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n) =>
    (ts.getModifiers?.(n) || []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      localHoisted.add(node.name.text);
      if (isExported(node)) hoisted.add(isDefault(node) ? 'default' : node.name.text);
    } else if (ts.isVariableStatement(node)) {
      const isVar =
        (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      if (isVar) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            localHoisted.add(d.name.text);
            if (isExported(node)) hoisted.add(d.name.text);
          }
        }
      }
    }
  });
  // `export { f }` where f is a hoisted declaration above.
  ts.forEachChild(sf, (node) => {
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const el of node.exportClause.elements) {
        const local = (el.propertyName || el.name).text;
        if (localHoisted.has(local)) hoisted.add(el.name.text);
      }
    }
  });
  return hoisted;
}

function bindingNames(ts, clause) {
  const names = [];
  if (!clause) return names;
  if (clause.name) names.push(clause.name.text);
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamespaceImport(nb)) names.push(nb.name.text);
    else for (const el of nb.elements) names.push(el.name.text);
  }
  return names;
}

/** Parse one file and return the raw import records, before resolution. */
export function parseFile(ts, abs, source) {
  const scriptKind = abs.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : abs.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : abs.endsWith('.js') || abs.endsWith('.mjs') || abs.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, scriptKind);
  const { valueUses, moduleTimeUses } = collectUses(ts, sf);
  const hoisted = hoistedExportNames(ts, sf);
  const records = [];
  const dynamic = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const textOf = (node) => {
    const t = node.getText(sf) || '';
    return t.split('\n')[0].trim().slice(0, 160);
  };

  const push = (r) => records.push(r);

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const clause = node.importClause;
        if (!clause) {
          push({
            spec: spec.text,
            line: lineOf(node),
            text: textOf(node),
            timing: 'import-time',
            kind: 'side-effect',
            needsBinding: false,
            detail: 'a bare import runs the other module for its side effects',
          });
        } else if (clause.isTypeOnly) {
          push({
            spec: spec.text,
            line: lineOf(node),
            text: textOf(node),
            timing: 'erased',
            kind: 'import-type',
            needsBinding: false,
            detail: '`import type` is removed by the compiler and emits no JavaScript',
          });
        } else {
          const names = bindingNames(ts, clause);
          const nb = clause.namedBindings;
          let moduleTimeExportNames = [];
          if (nb && ts.isNamespaceImport(nb) && moduleTimeUses.has(nb.name.text)) {
            // A namespace object is read as a whole, so no single export name covers it.
            moduleTimeExportNames = null;
          } else {
            if (clause.name && moduleTimeUses.has(clause.name.text)) {
              moduleTimeExportNames.push('default');
            }
            if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) {
                if (el.isTypeOnly) continue;
                if (moduleTimeUses.has(el.name.text)) {
                  moduleTimeExportNames.push((el.propertyName || el.name).text);
                }
              }
            }
          }
          const allSpecifiersTypeOnly =
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            !clause.name &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly);
          const usedAsValue = names.some((n) => valueUses.has(n));
          const usedAtModuleTime = names.some((n) => moduleTimeUses.has(n));
          if (allSpecifiersTypeOnly) {
            push({
              spec: spec.text,
              line: lineOf(node),
              text: textOf(node),
              timing: 'erased',
              kind: 'import-type',
              needsBinding: false,
              detail: 'every specifier is marked `type`, so the import is removed by the compiler',
            });
          } else if (!usedAsValue) {
            push({
              spec: spec.text,
              line: lineOf(node),
              text: textOf(node),
              timing: 'erased',
              kind: 'elided',
              needsBinding: false,
              detail:
                `${names.join(', ')} is never used as a value, so tsc elides this import. ` +
                'Set verbatimModuleSyntax to keep it, and this edge becomes real.',
            });
          } else {
            push({
              spec: spec.text,
              line: lineOf(node),
              text: textOf(node),
              timing: 'import-time',
              kind: 'import',
              names: moduleTimeExportNames,
              needsBinding: usedAtModuleTime,
              detail: usedAtModuleTime
                ? `${names.filter((n) => moduleTimeUses.has(n)).join(', ')} is read while this module's body runs`
                : 'the imported bindings are only read inside functions, so the live binding is filled in by then',
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const typeOnly =
          node.isTypeOnly ||
          (node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((e) => e.isTypeOnly));
        push({
          spec: spec.text,
          line: lineOf(node),
          text: textOf(node),
          timing: typeOnly ? 'erased' : 'import-time',
          kind: typeOnly ? 'export-type-from' : 're-export',
          needsBinding: false,
          detail: typeOnly
            ? 'a type only re-export emits no JavaScript'
            : 're-exported ESM bindings stay live, so the value is read at use time, not here',
        });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        push({
          spec: ref.expression.text,
          line: lineOf(node),
          text: textOf(node),
          timing: node.isTypeOnly ? 'erased' : 'import-time',
          kind: 'import-equals',
          needsBinding: !node.isTypeOnly && moduleTimeUses.has(node.name.text),
          detail: 'import = require() is a CommonJS style eager import',
        });
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (isDynamicImport) {
            push({
              spec: arg.text,
              line: lineOf(node),
              text: textOf(node),
              timing: 'deferred',
              kind: 'dynamic-import',
              needsBinding: false,
              detail: 'import() returns a promise and runs after the current module has finished',
            });
          } else {
            const parent = node.parent;
            const destructured =
              parent &&
              ts.isVariableDeclaration(parent) &&
              parent.name &&
              ts.isObjectBindingPattern(parent.name);
            const bound =
              parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
                ? parent.name.text
                : null;
            push({
              spec: arg.text,
              line: lineOf(node),
              text: textOf(node),
              timing: 'import-time',
              kind: 'require',
              needsBinding: Boolean(destructured) || Boolean(bound && moduleTimeUses.has(bound)),
              detail: destructured
                ? 'destructuring a require() copies the properties that exist right now'
                : 'require() returns whatever module.exports holds at this instant',
            });
          }
        } else if (arg) {
          dynamic.push({
            line: lineOf(node),
            reason: isDynamicImport
              ? 'import() with a computed specifier cannot be resolved statically'
              : 'require() with a computed specifier cannot be resolved statically',
            text: textOf(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { records, dynamic, hoisted: [...hoisted].sort() };
}

/**
 * Build the TypeScript/JavaScript part of the graph.
 * Returns { nodes, edges, unresolved, parseErrors, externalCount }.
 */
export function typescriptGraph(root, opts = {}) {
  const ts = loadTypeScript();
  const absPaths = (opts.files || walk(root, TS_EXT, opts.ignores)).filter(
    (p) => !p.endsWith('.d.ts') || opts.includeDeclarations,
  );
  const nodes = absPaths.map((p) => toId(root, p));
  const nodeSet = new Set(nodes);
  const edges = [];
  const unresolved = [];
  const parseErrors = [];
  /** fileId -> export names that are hoisted, so reading them mid-cycle is safe. */
  const hoisted = {};
  let externalCount = 0;

  for (const abs of absPaths) {
    const id = toId(root, abs);
    let source;
    try {
      source = require('node:fs').readFileSync(abs, 'utf8');
    } catch (e) {
      parseErrors.push({ file: id, language: 'typescript', message: `could not read: ${e.message}` });
      continue;
    }
    let parsed;
    try {
      parsed = parseFile(ts, abs, source);
    } catch (e) {
      parseErrors.push({ file: id, language: 'typescript', message: String(e.message).slice(0, 200) });
      continue;
    }
    hoisted[id] = parsed.hoisted;
    for (const d of parsed.dynamic) {
      unresolved.push({ file: id, language: 'typescript', line: d.line, reason: d.reason, text: d.text });
    }
    for (const r of parsed.records) {
      const targetAbs = resolveSpecifier(abs, r.spec);
      if (!targetAbs) {
        externalCount += 1;
        continue;
      }
      const to = toId(root, targetAbs);
      if (!nodeSet.has(to)) {
        externalCount += 1;
        continue;
      }
      if (to === id) continue;
      edges.push({
        from: id,
        to,
        language: 'typescript',
        line: r.line,
        timing: r.timing,
        kind: r.kind,
        needsBinding: r.needsBinding,
        conditional: false,
        names: r.names === undefined ? null : r.names,
        detail: r.detail,
        text: r.text,
      });
    }
  }
  return { nodes, edges, unresolved, parseErrors, externalCount, hoisted };
}
