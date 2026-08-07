#!/usr/bin/env node
/* One digest over everything this tool measures, so a change in behaviour is visible as a change
 * in one hex string.
 *
 * This exists for scripts/sabotage.py. A sabotage that does not move this number has not
 * sabotaged anything, and any conclusion drawn from a passing test afterwards would be about
 * nothing at all. It covers the demo report, the rendered page, and the ranking of every fixture
 * tree, because a change can show up in the graph, in the HTML, or only in one language.
 *
 * Nothing machine specific goes into it: the paths are relative, the version is dropped, and
 * there is no timestamp, so an untouched copy of the tree in a different directory digests to the
 * same value. That property is the null control.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTree } from '../src/analyze.mjs';
import { renderHtml } from '../src/html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parts = [];

function add(label, value) {
  parts.push(`${label}\t${value}`);
}

const demo = analyzeTree(join(ROOT, 'fixtures', 'demo'), { label: 'demo', version: 'fixed' });
add('demo.totals', JSON.stringify(demo.totals));
add('demo.bySeverity', JSON.stringify(demo.bySeverity));
add('demo.unresolved', JSON.stringify(demo.unresolved.map((u) => `${u.file}:${u.line}`)));
add('demo.parseErrors', JSON.stringify(demo.parseErrors.map((p) => p.file)));
for (const c of demo.cycles) {
  add(
    `demo.cycle.${c.id}`,
    JSON.stringify([
      c.severity,
      c.nodes,
      c.structuralSize,
      c.edges.map((e) => [e.from, e.to, e.line, e.kind, e.timing, e.needsBinding, e.executes]),
      c.break.method,
      c.break.proven,
      c.break.arcs.map((a) => [a.from, a.to]),
    ]),
  );
}
add('demo.html', createHash('sha256').update(renderHtml(demo)).digest('hex'));

const treesDir = join(ROOT, 'fixtures', 'trees');
for (const name of readdirSync(treesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  const lang = name.startsWith('py-') ? 'py' : 'ts';
  let value;
  try {
    const r = analyzeTree(join(treesDir, name), { lang, label: name, version: 'fixed' });
    value = JSON.stringify([
      r.totals.modules,
      r.totals.edges,
      r.totals.importTimeEdges,
      r.totals.deferredEdges,
      r.totals.erasedEdges,
      r.unresolved.length,
      r.cycles.map((c) => [c.severity, c.nodes, c.break.arcs.map((a) => `${a.from}>${a.to}`)]),
    ]);
  } catch (e) {
    value = `THREW ${String(e.message).slice(0, 120)}`;
  }
  add(`tree.${name}`, value);
}

const body = parts.join('\n');
process.stdout.write(`${createHash('sha256').update(body).digest('hex')}\n`);
if (process.argv.includes('--verbose')) process.stdout.write(`${body}\n`);
