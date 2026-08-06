#!/usr/bin/env node
/* Check the tool against the fixture trees two different ways.
 *
 * First against fixtures/trees/expected.json, which was written by hand before the tool ever ran
 * on these trees. That catches the analysis changing.
 *
 * Second, and this is the one that matters, against the language runtime. Every fixture that says
 * "expect: throws" is imported in a real Python or Node subprocess and has to actually raise, with
 * the error text the file predicted. Every fixture that says "expect: ok" has to import cleanly.
 * Then the two are tied together by one invariant:
 *
 *     a tree that raises MUST have a cycle ranked `breaks`
 *     a tree that imports cleanly MUST NOT
 *
 * Without that, "breaks at runtime" is a label the tool assigns to itself. With it, the label is
 * checked against the only authority there is, which is Python and V8.
 *
 * The type-only fixtures cannot be run, because the whole claim is that the import disappears
 * before there is anything to run. Those are checked by transpiling the file with the TypeScript
 * compiler and asserting the emitted JavaScript never mentions the other module.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTree } from '../src/analyze.mjs';
import { loadTypeScript } from '../src/typescript.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREES = join(ROOT, 'fixtures', 'trees');
const spec = JSON.parse(readFileSync(join(TREES, 'expected.json'), 'utf8'));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

if (spec.trees.length < 10) {
  fail(`only ${spec.trees.length} fixture trees, which is not a fixture set`);
}
const negatives = spec.trees.filter((t) => t.cycles.length === 0);
if (negatives.length < 2) {
  fail(
    `only ${negatives.length} fixture trees with no cycles at all. A detector that reports ` +
      'cycles everywhere passes a suite that only checks it found the planted ones.',
  );
}

for (const t of spec.trees) {
  const dir = join(TREES, t.dir);
  let report;
  try {
    report = analyzeTree(dir, { lang: t.lang, label: t.dir, version: 'test' });
  } catch (e) {
    fail(`${t.dir}: analysis threw: ${e.message}`);
    continue;
  }

  const got = report.cycles
    .map((c) => `${c.severity}:${c.nodes.join('+')}`)
    .sort()
    .join(' ');
  const want = t.cycles
    .map((c) => `${c.severity}:${[...c.nodes].sort().join('+')}`)
    .sort()
    .join(' ');
  if (got !== want) {
    fail(`${t.dir}: expected [${want || 'no cycles'}] got [${got || 'no cycles'}]`);
  } else {
    ok(`${t.dir}: ${want || 'no cycles, as expected'}`);
  }

  if (report.unresolved.length !== t.unresolved) {
    fail(
      `${t.dir}: expected ${t.unresolved} unresolvable import(s), got ${report.unresolved.length}`,
    );
  }

  if (t.runtime) {
    const res = spawnSync(t.runtime.argv[0], t.runtime.argv.slice(1), {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (res.error) {
      fail(`${t.dir}: could not run ${t.runtime.argv.join(' ')}: ${res.error.message}`);
      continue;
    }
    const threw = res.status !== 0;
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    if (t.runtime.expect === 'throws') {
      if (!threw) {
        fail(`${t.dir}: the runtime was expected to raise and exited 0`);
      } else if (t.runtime.match && !output.includes(t.runtime.match)) {
        fail(`${t.dir}: raised, but not with "${t.runtime.match}": ${output.trim().split('\n').pop()}`);
      } else {
        ok(`${t.dir}: really raises (${(output.trim().split('\n').pop() || '').slice(0, 88)})`);
      }
    } else if (threw) {
      fail(`${t.dir}: expected a clean import, exit ${res.status}: ${output.trim().split('\n').pop()}`);
    } else {
      ok(`${t.dir}: really imports cleanly`);
    }

    // The invariant that makes the severity label mean something.
    const hasBreaks = report.cycles.some((c) => c.severity === 'breaks');
    if (t.runtime.expect === 'throws' && !hasBreaks) {
      fail(`${t.dir}: the runtime raises and the tool reported nothing as breaking`);
    }
    if (t.runtime.expect === 'ok' && hasBreaks) {
      fail(`${t.dir}: the tool called this breaking and it imports without complaint`);
    }
  }

  if (t.erasure) {
    const ts = loadTypeScript();
    const src = readFileSync(join(dir, t.erasure.file), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: t.erasure.file,
    }).outputText;
    if (out.includes(t.erasure.mustNotReference)) {
      fail(
        `${t.dir}: the tool called the ${t.erasure.file} import erased, but tsc still emits ` +
          `a reference to ${t.erasure.mustNotReference}`,
      );
    } else {
      ok(`${t.dir}: tsc really does emit no reference to ${t.erasure.mustNotReference}`);
    }
  }
}

console.log(
  failures === 0
    ? `${spec.trees.length} fixture trees agree with the hand written answer and with the runtime`
    : `${failures} fixture check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
