/* Render the report as one HTML file with nothing outside it.
 *
 * No CDN, no fonts, no images, no fetch. The output is meant to be uploaded as a CI artifact and
 * opened from a file:// URL by somebody who has never heard of this tool, possibly on a laptop
 * with no network. Anything loaded over the wire would render that page blank in exactly the
 * situation it is needed.
 *
 * The data goes in as JSON in a script tag and the page builds itself from it, so the numbers on
 * the page and the numbers in --json are the same numbers.
 */

const SEV = {
  breaks: {
    label: 'breaks at runtime',
    short: 'breaks',
    blurb: 'runs at import time and needs a name that is not there yet',
  },
  fragile: {
    label: 'fragile',
    short: 'fragile',
    blurb: 'runs at import time, works today, one top level use away from failing',
  },
  lazy: {
    label: 'deferred',
    short: 'deferred',
    blurb: 'closes only through an import that runs later, so it never bites',
  },
  types: {
    label: 'types only',
    short: 'types',
    blurb: 'closes only through imports the compiler erases',
  },
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function embed(obj) {
  // A literal </script> inside JSON would end the tag early. U+2028/9 are newlines to a JS parser.
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CSS = `
:root{
  --bg:#fbfbfa; --fg:#1b1b19; --muted:#6b6b64; --line:#e0dfd8; --card:#ffffff;
  --breaks:#b3261e; --fragile:#9a6700; --lazy:#1f6feb; --types:#6b6b64;
  --breaks-bg:#fdecea; --fragile-bg:#fdf5e0; --lazy-bg:#e9f1fe; --types-bg:#f1f1ee;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#15161a; --fg:#e8e8e4; --muted:#9a9a92; --line:#2c2e34; --card:#1c1e23;
    --breaks:#ff8a80; --fragile:#e3b341; --lazy:#79b8ff; --types:#9a9a92;
    --breaks-bg:#2a1a19; --fragile-bg:#292214; --lazy-bg:#16212f; --types-bg:#232428;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 18px 80px}
h1{font-size:1.45rem;margin:0 0 4px;letter-spacing:-0.01em}
h2{font-size:1.02rem;margin:34px 0 10px;letter-spacing:-0.01em}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 22px}
.sub code{font-family:var(--mono);font-size:.85em;overflow-wrap:anywhere}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:0 0 8px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px 13px;min-width:0}
.tile .n{font-size:1.5rem;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}
.tile .k{color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.05em;
  margin-top:3px;overflow-wrap:anywhere}
.tile.breaks .n{color:var(--breaks)} .tile.fragile .n{color:var(--fragile)}
.tile.lazy .n{color:var(--lazy)} .tile.types .n{color:var(--types)}
.note{border:1px solid var(--line);border-left:3px solid var(--muted);background:var(--card);
  border-radius:0 8px 8px 0;padding:11px 14px;margin:14px 0;font-size:.88rem;color:var(--fg)}
.note.warn{border-left-color:var(--fragile)}
.note h3{margin:0 0 6px;font-size:.86rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.note ul{margin:6px 0 0;padding-left:18px}
.note li{margin:3px 0;overflow-wrap:anywhere}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0 14px;
  position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;border-bottom:1px solid var(--line)}
button.filter{font:inherit;font-size:.82rem;padding:5px 11px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--muted)}
button.filter[aria-pressed="true"]{color:var(--fg);border-color:currentColor;font-weight:600}
button.filter[aria-pressed="true"][data-sev="breaks"]{color:var(--breaks);background:var(--breaks-bg)}
button.filter[aria-pressed="true"][data-sev="fragile"]{color:var(--fragile);background:var(--fragile-bg)}
button.filter[aria-pressed="true"][data-sev="lazy"]{color:var(--lazy);background:var(--lazy-bg)}
button.filter[aria-pressed="true"][data-sev="types"]{color:var(--types);background:var(--types-bg)}
input[type=search]{font:inherit;font-size:.85rem;padding:5px 10px;border-radius:7px;
  border:1px solid var(--line);background:var(--card);color:var(--fg);flex:1 1 150px;min-width:0}
.count{color:var(--muted);font-size:.82rem;flex:0 0 auto}
.cycle{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 11px;
  overflow:hidden}
.cycle>summary{cursor:pointer;padding:12px 14px;list-style:none;display:block}
.cycle>summary::-webkit-details-marker{display:none}
.cycle>summary:focus-visible{outline:2px solid var(--lazy);outline-offset:-2px}
.head{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.pill{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  padding:2px 8px;border-radius:999px;white-space:nowrap}
.pill.breaks{color:var(--breaks);background:var(--breaks-bg)}
.pill.fragile{color:var(--fragile);background:var(--fragile-bg)}
.pill.lazy{color:var(--lazy);background:var(--lazy-bg)}
.pill.types{color:var(--types);background:var(--types-bg)}
.title{font-family:var(--mono);font-size:.85rem;overflow-wrap:anywhere;min-width:0}
.why{color:var(--muted);font-size:.85rem;margin:7px 0 0}
.body{border-top:1px solid var(--line);padding:13px 14px}
.chain{list-style:none;margin:0 0 4px;padding:0}
.chain li{padding:7px 0;border-bottom:1px dashed var(--line)}
.chain li:last-child{border-bottom:none}
.arrow{font-family:var(--mono);font-size:.82rem;overflow-wrap:anywhere}
.arrow .to{font-weight:650}
.meta{color:var(--muted);font-size:.78rem;margin-top:2px;overflow-wrap:anywhere}
.tag{font-family:var(--mono);font-size:.72rem;border:1px solid var(--line);border-radius:5px;
  padding:0 5px;margin-right:5px;white-space:nowrap;display:inline-block}
.tag.rt{color:var(--breaks)} .tag.df{color:var(--lazy)} .tag.er{color:var(--types)}
pre{margin:5px 0 0;padding:7px 9px;background:var(--bg);border:1px solid var(--line);
  border-radius:6px;overflow-x:auto;font-family:var(--mono);font-size:.78rem}
.fix{margin-top:12px;padding:11px 13px;border-radius:8px;background:var(--bg);border:1px solid var(--line)}
.fix h4{margin:0 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.fix ul{margin:0;padding-left:17px}
.fix li{margin:5px 0;font-size:.85rem;overflow-wrap:anywhere}
.method{color:var(--muted);font-size:.77rem;margin-top:7px}
.empty{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:26px 18px;
  text-align:center;color:var(--muted)}
footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);
  color:var(--muted);font-size:.79rem}
footer p{margin:6px 0}
`;

const SCRIPT = String.raw`
(function () {
  var el = document.getElementById('report-data');
  if (!el) return;
  var data = JSON.parse(el.textContent);
  var SEV = __SEV__;
  var active = { breaks: true, fragile: true, lazy: true, types: true };
  var query = '';

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function timingTag(t) {
    var m = { 'import-time': ['rt', 'import time'], deferred: ['df', 'deferred'], erased: ['er', 'erased'] };
    var v = m[t] || ['', t];
    return h('span', 'tag ' + v[0], v[1]);
  }

  function renderCycle(c) {
    var d = h('details', 'cycle');
    d.dataset.sev = c.severity;
    d.dataset.text = (c.nodes.join(' ') + ' ' + c.why).toLowerCase();
    var s = h('summary');
    var head = h('div', 'head');
    head.appendChild(h('span', 'pill ' + c.severity, SEV[c.severity].short));
    head.appendChild(h('span', 'title', c.nodes.join('  \u2192  ') + (c.nodes.length > 1 ? '  \u21ba' : '  (self)')));
    s.appendChild(head);
    s.appendChild(h('p', 'why', c.why));
    d.appendChild(s);

    var body = h('div', 'body');
    var ul = h('ul', 'chain');
    c.edges.forEach(function (e) {
      var li = document.createElement('li');
      var a = h('div', 'arrow');
      a.appendChild(document.createTextNode(e.from + ' \u2192 '));
      a.appendChild(h('span', 'to', e.to));
      a.appendChild(document.createTextNode('  line ' + e.line));
      li.appendChild(a);
      var meta = h('div', 'meta');
      meta.appendChild(timingTag(e.timing));
      meta.appendChild(h('span', 'tag', e.kind));
      if (e.needsBinding) meta.appendChild(h('span', 'tag rt', 'needs a name now'));
      if (e.conditional) meta.appendChild(h('span', 'tag', 'conditional'));
      meta.appendChild(document.createTextNode(e.detail || ''));
      li.appendChild(meta);
      if (e.text) li.appendChild(h('pre', null, e.text));
      ul.appendChild(li);
    });
    body.appendChild(ul);

    var fix = h('div', 'fix');
    fix.appendChild(h('h4', null, c.break.arcs.length === 1
      ? 'remove 1 edge to break this cycle'
      : 'remove ' + c.break.arcs.length + ' edges to break this cycle'));
    var fl = document.createElement('ul');
    c.break.arcs.forEach(function (arc) {
      var li = document.createElement('li');
      li.appendChild(h('strong', null, arc.from + ' \u2192 ' + arc.to));
      li.appendChild(document.createTextNode(' at line ' + arc.statements.map(function (s) { return s.line; }).join(', ') + '. ' + arc.advice));
      fl.appendChild(li);
    });
    fix.appendChild(fl);
    fix.appendChild(h('p', 'method', c.break.proven
      ? 'This is a true minimum: every smaller set of edges was tried and none of them breaks the cycle (' + c.break.searched + ' subsets tested).'
      : 'Minimum feedback arc set is NP-hard, so this is the Eades, Lin and Smyth GR heuristic with redundant edges removed. No smaller subset of THIS set works, but a smaller set elsewhere in the component might.'));
    body.appendChild(fix);

    if (c.structuralSize > c.nodes.length) {
      body.appendChild(h('p', 'method', 'These ' + c.nodes.length + ' modules sit inside a wider ' + c.structuralSize + ' module component once deferred and type only imports are counted.'));
    }
    d.appendChild(body);
    return d;
  }

  var list = document.getElementById('cycles');
  var nodes = data.cycles.map(renderCycle);
  nodes.forEach(function (n) { list.appendChild(n); });

  var counter = document.getElementById('shown');
  function apply() {
    var shown = 0;
    nodes.forEach(function (n) {
      var ok = active[n.dataset.sev] && (query === '' || n.dataset.text.indexOf(query) !== -1);
      n.hidden = !ok;
      if (ok) shown += 1;
    });
    counter.textContent = shown + ' of ' + nodes.length + ' shown';
    var none = document.getElementById('nomatch');
    none.hidden = shown !== 0 || nodes.length === 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll('button.filter'), function (b) {
    b.addEventListener('click', function () {
      var sev = b.dataset.sev;
      active[sev] = !active[sev];
      b.setAttribute('aria-pressed', String(active[sev]));
      apply();
    });
  });
  var search = document.getElementById('q');
  search.addEventListener('input', function () {
    query = search.value.trim().toLowerCase();
    apply();
  });
  document.getElementById('expand').addEventListener('click', function () {
    var anyClosed = nodes.some(function (n) { return !n.hidden && !n.open; });
    nodes.forEach(function (n) { if (!n.hidden) n.open = anyClosed; });
  });
  apply();
  document.documentElement.dataset.ready = '1';
})();
`;

export function renderHtml(report) {
  const t = report.totals;
  const tiles = [
    { n: t.modules, k: 'modules', cls: '' },
    { n: t.edges, k: 'import edges', cls: '' },
    { n: report.bySeverity.breaks, k: 'break at runtime', cls: 'breaks' },
    { n: report.bySeverity.fragile, k: 'fragile', cls: 'fragile' },
    { n: report.bySeverity.lazy, k: 'deferred', cls: 'lazy' },
    { n: report.bySeverity.types, k: 'types only', cls: 'types' },
  ];

  const incomplete = [];
  if (report.unresolved.length > 0) {
    incomplete.push(
      `<h3>the graph is incomplete</h3><p>${report.unresolved.length} import${
        report.unresolved.length === 1 ? '' : 's'
      } could not be resolved because the target is computed at runtime. Any cycle through these is invisible to this report.</p><ul>` +
        report.unresolved
          .slice(0, 40)
          .map(
            (u) =>
              `<li><code>${esc(u.file)}</code> line ${u.line}: ${esc(u.reason)}<br><code>${esc(
                u.text || '',
              )}</code></li>`,
          )
          .join('') +
        (report.unresolved.length > 40
          ? `<li>and ${report.unresolved.length - 40} more, in the JSON output</li>`
          : '') +
        '</ul>',
    );
  }
  if (report.parseErrors.length > 0) {
    incomplete.push(
      `<h3>files that did not parse</h3><p>${report.parseErrors.length} file${
        report.parseErrors.length === 1 ? '' : 's'
      } could not be read, so their imports are missing from the graph.</p><ul>` +
        report.parseErrors
          .slice(0, 20)
          .map((p) => `<li><code>${esc(p.file)}</code>: ${esc(p.message)}</li>`)
          .join('') +
        '</ul>',
    );
  }

  const langBits = [];
  if (report.languages.python) langBits.push(`${report.languages.python} Python files`);
  if (report.languages.typescript) langBits.push(`${report.languages.typescript} TypeScript or JavaScript files`);

  const body = `
<div class="wrap">
  <h1>Import cycles in ${esc(report.label)}</h1>
  <p class="sub">${esc(langBits.join(', ') || 'no source files found')}, ${t.modules} modules inside the tree,
    ${t.edges} resolved import edges (${t.importTimeEdges} run at import time, ${t.deferredEdges} deferred,
    ${t.erasedEdges} erased by the compiler). ${t.externalImportsIgnored} imports pointed outside the tree
    and were ignored. Built by <code>${esc(report.tool.name)} ${esc(report.tool.version)}</code>.</p>

  <div class="tiles">
    ${tiles
      .map(
        (x) =>
          `<div class="tile ${x.cls}"><div class="n">${x.n}</div><div class="k">${esc(x.k)}</div></div>`,
      )
      .join('\n    ')}
  </div>

  <div class="note">
    <h3>how these are ranked</h3>
    <ul>
      ${Object.entries(SEV)
        .map(([k, v]) => `<li><strong>${esc(v.label)}</strong>: ${esc(v.blurb)}</li>`)
        .join('\n      ')}
    </ul>
  </div>
  ${incomplete.map((x) => `<div class="note warn">${x}</div>`).join('\n  ')}
  ${
    report.complete
      ? '<div class="note"><h3>coverage</h3><p>Every import in this tree resolved to either a file inside it or a package outside it, and every file parsed. Nothing was silently dropped.</p></div>'
      : ''
  }

  <h2>Cycles</h2>
  <div class="bar">
    ${Object.entries(SEV)
      .map(
        ([k, v]) =>
          `<button class="filter" type="button" data-sev="${k}" aria-pressed="true">${esc(
            v.label,
          )} (${report.bySeverity[k]})</button>`,
      )
      .join('\n    ')}
    <input type="search" id="q" placeholder="filter by module name" aria-label="filter by module name">
    <button class="filter" type="button" id="expand" aria-pressed="false">expand all</button>
    <span class="count" id="shown"></span>
  </div>
  <div id="cycles"></div>
  <div class="empty" id="nomatch" hidden>Nothing matches that filter.</div>
  ${
    report.cycles.length === 0
      ? '<div class="empty">No cycles at all. Every module in this tree can be loaded without waiting on a module that is waiting on it.</div>'
      : ''
  }

  <footer>
    <p><strong>What "remove these edges" means.</strong> Finding the smallest set of imports whose
      removal breaks a cycle is the minimum feedback arc set problem, which is NP-hard. Cycles small
      enough to search exhaustively get a proven minimum and say so. Larger ones get the Eades, Lin
      and Smyth GR heuristic, reduced so that no edge in the answer is redundant, and say that too.</p>
    <p><strong>What this can miss.</strong> Imports whose target is computed at runtime are listed
      above rather than guessed at. Name resolution is per file and does not consult tsconfig path
      aliases or Python namespace packages installed elsewhere. Both make the graph smaller than
      reality, never larger, so a cycle reported here is real and a clean report is not a proof.</p>
    <p>This file has no external requests in it. It works from a file:// URL with the network off.</p>
  </footer>
</div>`;

  const script = SCRIPT.replace(
    '__SEV__',
    JSON.stringify(SEV).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'),
  );

  return `<!doctype html>
<html lang="en" data-ready="0">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Import cycles in ${esc(report.label)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
<script type="application/json" id="report-data">${embed(report)}</script>
<script>${script}</script>
</body>
</html>
`;
}
