#!/usr/bin/env node
/* Load docs/index.html in a real browser and measure what it actually did.
 *
 * The unit tests import the renderer and never load the page, so an unbalanced bracket in the
 * inline script would leave every one of them green while the page rendered as an empty shell.
 * Everything asserted here is something that only exists if the script parsed and ran to the end.
 *
 * The layout half looks for content escaping the page at 390px. It walks the elements and
 * compares each one's right edge against the viewport, ignoring anything inside a container that
 * is allowed to scroll sideways, because a wide code line scrolling inside its own box is correct
 * and only content pushing the whole document sideways is not. `overflow-x: hidden` on the body
 * would hide the bug and make the scrollWidth probe say nothing at the same time, so the CSS does
 * not contain it and this check would not notice if it did.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PAGE = join(root, 'docs', 'index.html');
const TITLE_PREFIX = 'Import cycles in ';

const require = createRequire(join(root, 'package.json'));
const candidates = [
  process.env.PLAYWRIGHT_CORE,
  join(root, 'node_modules', 'playwright-core'),
  'playwright-core',
].filter(Boolean);

let browser = null;
let resolvedFrom = null;
const attempts = [];
for (const c of candidates) {
  let mod;
  try {
    mod = await import(c.startsWith('/') ? `file://${require.resolve(c)}` : c);
  } catch {
    attempts.push(`${c}: not importable`);
    continue;
  }
  const chromium = mod.chromium ?? mod.default?.chromium ?? null;
  if (!chromium) {
    attempts.push(`${c}: no chromium export`);
    continue;
  }
  try {
    // A copy can import cleanly and still be unusable because its pinned browser build is not in
    // the local cache. A candidate counts only once a browser is actually running.
    browser = await chromium.launch();
  } catch (e) {
    attempts.push(`${c}: ${String(e).split('\n')[0].slice(0, 100)}`);
    continue;
  }
  resolvedFrom = c;
  break;
}

if (!browser) {
  process.stderr.write(
    'no usable playwright-core, so the page was never loaded in a browser.\n' +
      'This is a FAILURE and not a skip: the inline script can fail to parse while every unit\n' +
      'test passes, because the tests import the renderer and never open the page.\n' +
      'Install it with:  npm install --no-save playwright-core && npx playwright install chromium\n' +
      `Tried:\n${attempts.map((a) => `  ${a}`).join('\n')}\n`,
  );
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  ok    ${m}`);
};
const bad = (m) => {
  fail += 1;
  console.log(`  FAIL  ${m}`);
};

const html = readFileSync(PAGE, 'utf8');
const embedded = JSON.parse(
  /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1],
);

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => bad(`uncaught error on the page: ${String(e).slice(0, 140)}`));
  await page.goto(`file://${PAGE}`, { waitUntil: 'load' });
  // The browser is shared with other agents on this machine, so identity is asserted inside every
  // measurement rather than assumed from the navigate that preceded it.
  const title = await page.title();
  if (!title.startsWith(TITLE_PREFIX)) {
    throw new Error(`loaded the wrong page: title is ${JSON.stringify(title)}`);
  }
  return page;
}

try {
  // ---------------------------------------------------------------- desktop
  const page = await open(1280, 900);

  const ready = await page.evaluate(() => document.documentElement.dataset.ready);
  if (ready === '1') ok('the inline script ran to completion');
  else bad(`the script did not finish: data-ready is ${JSON.stringify(ready)}`);

  const built = await page.evaluate(() => ({
    cards: document.querySelectorAll('#cycles details.cycle').length,
    pills: [...document.querySelectorAll('#cycles .pill')].map((n) => n.textContent),
    tiles: [...document.querySelectorAll('.tile .n')].map((n) => Number(n.textContent)),
    shown: document.getElementById('shown').textContent,
    title: document.title,
  }));
  if (built.cards === embedded.cycles.length) {
    ok(`${built.cards} cycle cards drawn, one per cycle in the embedded data`);
  } else {
    bad(`${built.cards} cards drawn for ${embedded.cycles.length} cycles in the data`);
  }
  if (built.cards === 0) bad('the demo page has no cycles on it, so nothing was really tested');

  const wantCounts = ['breaks', 'fragile', 'lazy', 'types'].map((s) => embedded.bySeverity[s]);
  const gotCounts = built.tiles.slice(2);
  if (JSON.stringify(gotCounts) === JSON.stringify(wantCounts)) {
    ok(`the severity tiles read ${gotCounts.join('/')}, matching the data`);
  } else {
    bad(`tiles read ${gotCounts.join('/')} and the data says ${wantCounts.join('/')}`);
  }

  const perSev = {};
  for (const p of built.pills) perSev[p] = (perSev[p] || 0) + 1;
  const dataPerSev = {};
  for (const c of embedded.cycles) {
    const short = { breaks: 'breaks', fragile: 'fragile', lazy: 'deferred', types: 'types' }[
      c.severity
    ];
    dataPerSev[short] = (dataPerSev[short] || 0) + 1;
  }
  if (JSON.stringify(perSev) === JSON.stringify(dataPerSev)) {
    ok(`the badges on the cards match the data: ${JSON.stringify(perSev)}`);
  } else {
    bad(`badges ${JSON.stringify(perSev)} vs data ${JSON.stringify(dataPerSev)}`);
  }

  // Filtering has to actually filter, and the count has to follow.
  const filtered = await page.evaluate(() => {
    const btn = document.querySelector('button.filter[data-sev="breaks"]');
    btn.click();
    const visible = [...document.querySelectorAll('#cycles details.cycle')].filter((n) => !n.hidden);
    const out = { after: visible.length, label: document.getElementById('shown').textContent };
    btn.click();
    out.restored = [...document.querySelectorAll('#cycles details.cycle')].filter((n) => !n.hidden)
      .length;
    return out;
  });
  const expectAfter = embedded.cycles.length - embedded.bySeverity.breaks;
  if (filtered.after === expectAfter && filtered.restored === embedded.cycles.length) {
    ok(`turning off one severity hid ${embedded.bySeverity.breaks} card(s) and turning it back on restored them`);
  } else {
    bad(`filter left ${filtered.after} cards, expected ${expectAfter} (restored ${filtered.restored})`);
  }

  const searched = await page.evaluate((needle) => {
    const q = document.getElementById('q');
    q.value = needle;
    q.dispatchEvent(new Event('input'));
    const n = [...document.querySelectorAll('#cycles details.cycle')].filter((x) => !x.hidden).length;
    q.value = 'zzzzz-no-such-module';
    q.dispatchEvent(new Event('input'));
    const none = [...document.querySelectorAll('#cycles details.cycle')].filter((x) => !x.hidden)
      .length;
    const empty = !document.getElementById('nomatch').hidden;
    q.value = '';
    q.dispatchEvent(new Event('input'));
    return { n, none, empty };
  }, embedded.cycles[0].nodes[0]);
  if (searched.n >= 1 && searched.none === 0 && searched.empty) {
    ok('search narrows the list and says so when nothing matches');
  } else {
    bad(`search behaved oddly: ${JSON.stringify(searched)}`);
  }

  // The fix advice is inside the collapsed body, so it only exists if the card was built fully.
  const detail = await page.evaluate(() => {
    const first = document.querySelector('#cycles details.cycle');
    first.open = true;
    return {
      arrows: first.querySelectorAll('.chain li').length,
      fix: first.querySelectorAll('.fix li').length,
      method: first.querySelector('.method').textContent,
    };
  });
  if (detail.arrows === embedded.cycles[0].edges.length && detail.fix === embedded.cycles[0].break.arcs.length) {
    ok(`the first card lists ${detail.arrows} import statement(s) and ${detail.fix} edge(s) to remove`);
  } else {
    bad(`first card drew ${detail.arrows} arrows and ${detail.fix} fixes, data says ${embedded.cycles[0].edges.length} and ${embedded.cycles[0].break.arcs.length}`);
  }
  if (/NP-hard|true minimum/.test(detail.method)) {
    ok('the card states which method produced the edge list');
  } else {
    bad(`the card does not say how the fix was computed: ${detail.method.slice(0, 80)}`);
  }

  const wide = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  if (wide.scroll <= wide.client) ok(`no sideways scroll at 1280px (${wide.scroll} <= ${wide.client})`);
  else bad(`the page scrolls sideways at 1280px: ${wide.scroll} > ${wide.client}`);
  await page.close();

  // ---------------------------------------------------------------- phone
  const small = await open(390, 844);
  await small.evaluate(() => {
    for (const d of document.querySelectorAll('#cycles details.cycle')) d.open = true;
  });
  const narrow = await small.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const offenders = [];
    const scrollable = (el) => {
      for (let n = el; n && n !== doc; n = n.parentElement) {
        const ov = getComputedStyle(n).overflowX;
        if (ov === 'auto' || ov === 'scroll') return true;
      }
      return false;
    };
    for (const el of doc.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > limit + 0.5 && !scrollable(el)) {
        offenders.push(`${el.tagName.toLowerCase()}.${el.className || '-'} right=${Math.round(r.right)}`);
      }
    }
    return {
      scroll: doc.scrollWidth,
      client: limit,
      offenders: offenders.slice(0, 6),
      cards: document.querySelectorAll('#cycles details.cycle').length,
      bodyOverflow: getComputedStyle(document.body).overflowX,
    };
  });
  if (narrow.cards === embedded.cycles.length) ok(`all ${narrow.cards} cards still render at 390px`);
  else bad(`only ${narrow.cards} cards at 390px`);
  if (narrow.bodyOverflow === 'hidden') {
    bad('body has overflow-x: hidden, which hides real overflow and makes this check vacuous');
  } else {
    ok(`body overflow-x is ${narrow.bodyOverflow}, so overflow would be visible to this check`);
  }
  if (narrow.scroll <= narrow.client) {
    ok(`no sideways scroll at 390px (${narrow.scroll} <= ${narrow.client})`);
  } else {
    bad(`the page scrolls sideways at 390px: ${narrow.scroll} > ${narrow.client}`);
  }
  if (narrow.offenders.length === 0) ok('no element escapes the viewport at 390px');
  else bad(`elements past the right edge at 390px: ${narrow.offenders.join('; ')}`);
  await small.close();

  // ---------------------------------------------------------------- no network
  const requests = [];
  const probe = await open(1024, 768);
  probe.on('request', (r) => {
    if (!r.url().startsWith('file:')) requests.push(r.url());
  });
  await probe.reload({ waitUntil: 'load' });
  if (requests.length === 0) ok('the page made no request off the filesystem');
  else bad(`the page fetched ${requests.length} external resource(s): ${requests.slice(0, 3)}`);
  await probe.close();
} catch (e) {
  bad(`the browser check threw: ${String(e).split('\n')[0]}`);
} finally {
  await browser.close();
}

console.log(`${pass} passed, ${fail} failed in a real browser via ${resolvedFrom}`);
process.exit(fail === 0 ? 0 : 1);
