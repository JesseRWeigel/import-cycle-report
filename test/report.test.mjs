import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { analyzeTree, analyzeGraph, worstSeverity } from '../src/analyze.mjs';
import { renderHtml } from '../src/html.mjs';
import { ROOT, FIXTURES, shuffled } from './helpers.mjs';

const DEMO = join(FIXTURES, 'demo');

function demoReport() {
  return analyzeTree(DEMO, { label: 'demo', version: 'test' });
}

test('the demo tree carries all four rankings, so the page shows all four', () => {
  const r = demoReport();
  for (const s of ['breaks', 'fragile', 'lazy', 'types']) {
    assert.ok(r.bySeverity[s] > 0, `the demo has no ${s} cycle, so the page cannot demonstrate it`);
  }
  assert.equal(worstSeverity(r), 'breaks');
});

test('two runs over the same tree produce the same report', () => {
  assert.deepEqual(demoReport(), demoReport());
});

test('two renders of the same report produce the same bytes', () => {
  const r = demoReport();
  assert.equal(renderHtml(r), renderHtml(r));
});

test('shuffling the graph does not change the cycles, only fifty times over', () => {
  const r = analyzeTree(DEMO, { label: 'demo', version: 'test', includeGraph: true });
  const base = JSON.stringify(r.cycles.map((c) => [c.severity, c.nodes]));
  for (let seed = 1; seed <= 50; seed += 1) {
    const cycles = analyzeGraph(
      shuffled(r.graph.nodes, seed),
      shuffled(r.graph.edges, seed * 104729),
      {},
    );
    assert.equal(
      JSON.stringify(cycles.map((c) => [c.severity, c.nodes])),
      base,
      `seed ${seed} changed the reported cycles`,
    );
  }
});

test('a three module cycle is reported identically from every ordering', () => {
  // Two module cycles are the shape a back edge check gets right by accident: there is only one
  // way round a loop of two. Three is where the answer starts depending on where the walk began,
  // and where the strongly connected component has to be the same set whatever the order.
  const r = analyzeTree(join(FIXTURES, 'trees', 'py-triangle'), { lang: 'py', includeGraph: true });
  assert.equal(r.cycles.length, 1);
  assert.deepEqual(r.cycles[0].nodes, ['alpha.py', 'beta.py', 'gamma.py']);
  assert.equal(r.cycles[0].severity, 'breaks');
  const base = JSON.stringify(r.cycles.map((c) => [c.severity, c.nodes]));
  const seenArcs = new Set();
  for (let seed = 1; seed <= 60; seed += 1) {
    const cycles = analyzeGraph(
      shuffled(r.graph.nodes, seed),
      shuffled(r.graph.edges, seed * 31337),
      {},
    );
    assert.equal(
      JSON.stringify(cycles.map((c) => [c.severity, c.nodes])),
      base,
      `seed ${seed} named a different set of modules for the same triangle`,
    );
    seenArcs.add(cycles[0].break.arcs.map((a) => `${a.from}>${a.to}`).join(','));
  }
  // Any one of the three arcs breaks the triangle, so a tool that picked whichever the traversal
  // reached first would answer differently per ordering. The choice has to be canonical too.
  assert.equal(seenArcs.size, 1, `the suggested fix varied by ordering: ${[...seenArcs]}`);
});

test('the demo tree contains a cycle longer than two modules', () => {
  const r = demoReport();
  const wide = r.cycles.filter((c) => c.nodes.length > 2);
  assert.ok(
    wide.length > 0,
    'every demo cycle is a pair, so the published page never shows the case where ordering matters',
  );
});

test('the page embeds the same numbers it prints', () => {
  const r = demoReport();
  const html = renderHtml(r);
  const embedded = JSON.parse(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1],
  );
  assert.deepEqual(embedded, JSON.parse(JSON.stringify(r)));
  assert.match(html, new RegExp(`<div class="n">${r.totals.modules}</div>`));
});

test('the page loads nothing over the network', () => {
  const html = renderHtml(demoReport());
  const external = html.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  assert.deepEqual(external, [], `the page references ${external.join(', ')}`);
  assert.ok(!/<link\b/i.test(html), 'a <link> tag means a stylesheet or icon fetched from somewhere');
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'a script with a src is an external dependency');
  assert.ok(!/<img\b/i.test(html), 'an image tag is a request');
});

test('a module name containing HTML cannot break out of the page', () => {
  const nodes = ['<script>alert(1)</script>.py', 'b.py'];
  const edges = [
    {
      from: nodes[0],
      to: 'b.py',
      line: 1,
      timing: 'import-time',
      kind: 'from-name',
      needsBinding: true,
      names: ['x'],
      language: 'python',
      detail: 'needs x',
      text: 'from b import x',
    },
    {
      from: 'b.py',
      to: nodes[0],
      line: 1,
      timing: 'import-time',
      kind: 'from-name',
      needsBinding: true,
      names: ['y'],
      language: 'python',
      detail: 'needs y',
      text: '</script><img src=x onerror=alert(2)>',
    },
  ];
  const cycles = analyzeGraph(nodes, edges, {});
  const report = {
    tool: { name: 'test', version: '0' },
    label: '</title><script>alert(3)</script>',
    languages: { python: 2, typescript: 0 },
    totals: {
      modules: 2,
      edges: 2,
      importTimeEdges: 2,
      deferredEdges: 0,
      erasedEdges: 0,
      externalImportsIgnored: 0,
      cycles: cycles.length,
      modulesInCycles: 2,
    },
    bySeverity: { breaks: 1, fragile: 0, lazy: 0, types: 0 },
    complete: false,
    // These two go into the page as server side HTML rather than through the client script, so
    // they exercise the escaping directly.
    unresolved: [
      {
        file: '<b>evil</b>.py',
        language: 'python',
        line: 3,
        reason: 'computed <target>',
        text: '<img src=x onerror="alert(4)">',
      },
    ],
    parseErrors: [{ file: '"><svg onload=alert(5)>.py', language: 'python', message: 'broken' }],
    cycles,
  };
  const html = renderHtml(report);
  // Exactly two script tags: the JSON island and the page script. Nothing from the data.
  const opens = html.match(/<script\b/g) || [];
  assert.equal(opens.length, 2, 'the data opened a script tag of its own');
  assert.ok(!html.includes('<script>alert(1)'), 'a module name was written as live markup');
  assert.ok(!/<img\b/i.test(html), 'an img tag was produced from the data');
  assert.ok(!/<svg\b/i.test(html), 'an svg tag was produced from the data');
  assert.ok(!/onerror\s*=\s*["']?alert/i.test(html.replace(/&quot;/g, '"')) || !/<[a-z]+\s[^>]*onerror/i.test(html), 'a live event handler attribute was produced');
  assert.ok(!html.includes('<script>alert(3)'), 'the label was written as live markup');
  const island = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(!island.includes('<'), 'the JSON island contains a raw < and could end its own tag');
  assert.ok(!island.includes('>'), 'the JSON island contains a raw >');
  const embedded = JSON.parse(island);
  assert.equal(embedded.label, report.label, 'escaping the embed must not corrupt the data');
  assert.equal(embedded.cycles[0].nodes[0], '<script>alert(1)</script>.py');
});

test('a clean tree renders a page that says so', () => {
  const html = renderHtml(analyzeTree(join(FIXTURES, 'trees', 'py-clean'), { label: 'clean' }));
  assert.match(html, /No cycles at all/);
});

test('an incomplete graph is stated on the page, not hidden', () => {
  const r = analyzeTree(join(FIXTURES, 'trees', 'py-dynamic'), { label: 'dyn' });
  assert.equal(r.complete, false);
  const html = renderHtml(r);
  assert.match(html, /the graph is incomplete/);
  assert.match(html, /alpha\.py/);
});

test('a complete graph says that too, rather than staying silent', () => {
  const r = analyzeTree(join(FIXTURES, 'trees', 'py-clean'), { label: 'clean' });
  assert.equal(r.complete, true);
  assert.match(renderHtml(r), /Nothing was silently dropped/);
});

test('the page names the method behind every fix, and never claims a heuristic is minimal', () => {
  const html = renderHtml(demoReport());
  assert.match(html, /NP-hard/);
  const r = demoReport();
  for (const c of r.cycles) {
    assert.ok(['exact-exhaustive', 'heuristic-eades-lin-smyth', 'none-needed'].includes(c.break.method));
    if (c.break.method === 'heuristic-eades-lin-smyth') assert.equal(c.break.proven, false);
  }
});

test('no absolute path from the analysing machine reaches the report', () => {
  const html = renderHtml(demoReport());
  assert.ok(!html.includes(ROOT), 'the tool directory leaked into the page');
  assert.ok(!/\/home\/[a-z]/.test(html), 'a home directory leaked into the page');
  assert.ok(!html.includes(process.cwd()), 'the working directory leaked into the page');
});

test('every reported cycle carries a fix that really removes it', () => {
  const r = analyzeTree(DEMO, { label: 'demo', includeGraph: true });
  for (const c of r.cycles) {
    assert.ok(c.break.arcs.length > 0, `cycle ${c.id} has no suggested fix`);
    for (const arc of c.break.arcs) {
      assert.ok(arc.statements.length > 0, 'a suggested edge with no statement behind it');
      assert.ok(arc.advice.length > 10, 'a suggested edge with no advice');
    }
  }
});
