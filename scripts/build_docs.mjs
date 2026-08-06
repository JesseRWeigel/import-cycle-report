#!/usr/bin/env node
/* Build docs/index.html from the demo tree in fixtures/demo.
 *
 * The demo tree is committed, so this produces the same bytes on any machine and verify can
 * rebuild it and diff. Pointing this at a library installed on one particular laptop would make
 * the published page unreproducible and would put that laptop's directory layout in the output.
 *
 * The demo is a small application with two of each kind of cycle, in both languages, so the page
 * shows what the four rankings actually look like rather than describing them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { analyzeTree } from '../src/analyze.mjs';
import { renderHtml } from '../src/html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const report = analyzeTree(join(ROOT, 'fixtures', 'demo'), {
  label: 'the demo project',
  version: pkg.version,
});

mkdirSync(join(ROOT, 'docs'), { recursive: true });
const out = join(ROOT, 'docs', 'index.html');
writeFileSync(out, renderHtml(report));

const b = report.bySeverity;
process.stdout.write(
  `docs/index.html: ${report.totals.modules} modules, ${report.totals.edges} edges, ` +
    `${b.breaks} breaking, ${b.fragile} fragile, ${b.lazy} deferred, ${b.types} types-only, ` +
    `${report.unresolved.length} unresolvable import(s)\n`,
);
