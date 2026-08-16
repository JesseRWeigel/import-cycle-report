# import-cycle-report

Find the import cycles in a Python or TypeScript tree that can actually break it, and write one
self-contained HTML file you can open from disk or attach to an email.

**[The cycles found in the demo project →](https://jesserweigel.github.io/import-cycle-report/)**

> Measurements described here were taken on one development machine: an RTX 5090 with
> 32 GB of VRAM, 12 cores, 48 GB of RAM, running Linux under WSL2. Numbers from your own
> hardware will differ.

Catalog task: `DEVT-024`. One of a public catalog of build ideas:
https://github.com/JesseRWeigel/722-things-to-build

## What this is

A dependency checker that flags every cycle equally gets a "cycles: 47" badge, an argument, and
then a config line switching it off. So this one ranks them by whether the cycle can bite:

| Rank | What it means |
|---|---|
| **breaks** | Every edge runs at import time, and at least one of them needs a name out of a module that may still be part way through loading. This is what raises `ImportError` on startup, or hands you `undefined` in JavaScript. |
| **fragile** | Every edge runs at import time and nothing reads a name across the loop. Python is fine with this: `import a` binds a module object that exists from the first line. One top level use of that module turns it into `breaks` with no other change. |
| **lazy** | The loop only closes through an import inside a function or a dynamic `import()`. Module evaluation never goes round it. This is the standard, deliberate way to keep a cycle from mattering, and flagging it as a defect is how tools get muted. |
| **types** | The loop only closes through imports the compiler erases: `import type`, a value import used only in type position, `if TYPE_CHECKING:`. There is no cycle in the emitted JavaScript and none at Python runtime. |

The ranking is order-aware, which is the part that separates a report people act on from one they
mute. `from pkg import NAME` inside `pkg/sub.py` reads a name off a package that is already in
`sys.modules`, and whether it raises depends on whether `pkg/__init__.py` bound that name above
the line that led here. The `py-pkg` and `py-pkg-ordered` fixtures are the same code in two line
orders, and only the first one raises. In JavaScript the equivalent is hoisting: `export function
f` exists from the module's first instruction, `export const f = () => {}` does not.

### What it will not tell you

- **A dynamic import with a computed target cannot be resolved.** `importlib.import_module(name)`
  or `await import(path)` where the argument is a variable has no answer at parse time. Those
  imports are listed by file and line, the report says on its face that the graph is incomplete,
  and the count appears in the summary. They are never silently dropped.
- **The minimum feedback arc set is NP-hard** (Karp 1972). Components with 22 arcs or fewer get an
  exhaustive search, which is genuinely minimum and marked `proven`. Anything larger gets the
  Eades, Lin and Smyth GR heuristic (1993), reduced afterwards so no proper subset of the answer
  also works. That result is minimal and not minimum, it is labelled `heuristic-eades-lin-smyth`
  with `proven: false`, and the page says so in words. No claim of optimality is made anywhere.
- **A `.pyi` stub stands in for a compiled extension.** `markupsafe/_speedups` is a `.so` the tool
  cannot read, so the import resolves to the stub next to it. The edge is real, the file named is
  the only Python-visible representative of it.
- **Only Python and TypeScript/JavaScript.** No Go, Rust, Java, C++.

## Running it

```bash
npm install
node bin/cycles.mjs path/to/tree --out cycles.html
```

```
  --out <file>        write the HTML report here (default cycles.html)
  --json <file>       also write the raw report as JSON
  --label <name>      what to call the tree in the report. Defaults to the directory name.
                      No absolute path ever reaches the output.
  --lang py|ts|both   which languages to analyse (default both)
  --ignore <name>     directory name to skip, repeatable, added to the defaults
  --fail-on <level>   exit 1 when a cycle at this level or worse exists.
                      breaks (default), fragile, lazy, types, or never
  --include-graph     put the full node and edge list in the JSON output
  --quiet             only print the summary line
```

The output is one HTML file. No server, no CDN, no network request of any kind: the data is a
JSON island inside the page and the script that renders it is inline. A generated example is at
[`docs/index.html`](docs/index.html), built from the committed demo tree in `fixtures/demo`.

`--label` exists because these reports get attached to CI runs and emailed. The directory layout
of the machine that ran the scan is nobody else's business, so no absolute path reaches the page
and there is a check that fails the build if one does.

### Verify

```bash
bash scripts/verify.sh
```

Eleven steps, and the exit code is the result. Under a minute on a 12 core box, most of it the
sabotage harness copying the tree seventeen times.
Nothing prints success for a step it did not run: a missing `playwright-core` is a FAILURE with
the install command in the message, not a skip, because a skipped check and a passing check are
indistinguishable in a log a week later.

| Step | What it does |
|---|---|
| 1 | Toolchain and repository preconditions. Node 20+, python3, the two npm packages, a git repo. |
| 2 | 177 unit tests, and a floor on the count so a glob matching nothing cannot pass. |
| 3 | Every fixture tree checked against the hand-written ground truth AND against the real Python and Node runtimes. |
| 4 | The command line tool end to end, including a clean tree that must exit 0 at the strictest threshold. |
| 5 | `docs/index.html` rebuilt from the demo tree and diffed, so the published page cannot go stale. |
| 6 | The page loaded in a real browser and measured from inside. |
| 7 | Independent recomputation by Kosaraju, in Python, importing nothing from the package. |
| 8 | Privacy scan with a positive control. |
| 9 | The tool run against real source rather than fixtures only. |
| 10 | 17 sabotages under the three-gate rule, with a null control first. |
| 11 | The README has no stub left in it, carries a Status section, and its test count still matches. |

## How it is checked

The point of most of the machinery here is that a checker which agrees with itself proves nothing.

**Fixtures with known structure, including negative controls.** 20 source trees under
`fixtures/trees`, each with the cycles it must produce written down by hand before the tool ever
ran on it. Two of them, `py-clean` and `ts-clean`, are DAGs with no cycle at all, and the harness
fails if there are fewer than two such trees, because a detector that reports cycles everywhere
passes any suite that only checks it found the planted one. The graph fixtures in
`fixtures/graphs.json` add five more acyclic cases, and the suite enforces a floor there too.

**The runtime is the authority on the ranking.** "breaks at runtime" would otherwise be a label
the tool hands itself. So every fixture marked `throws` is imported in a real Python or Node
subprocess and has to raise, with the error text the fixture predicted, and every fixture marked
`ok` has to import cleanly. Then:

    a tree that raises MUST have a cycle ranked breaks
    a tree that imports cleanly MUST NOT

The type-only fixtures cannot be run, because the whole claim is that the import disappears before
there is anything to run. Those are transpiled with the real TypeScript compiler and the emitted
JavaScript has to contain no reference to the other module.

**Order independence is asserted, not assumed.** A DFS back-edge check reports a three-module
cycle as `(C, A)` or `(A, B)` or `(B, C)` depending only on where the walk started, which is why
this uses Tarjan and canonicalises the result. The tests run the analysis over 40 to 60 shuffled
orderings of the nodes and edges of every fixture graph, the demo tree, and the `py-triangle`
tree, and require byte-identical components each time. The suggested fix has to be stable across
orderings too: any one of a triangle's three arcs breaks it, so a tool that picked whichever the
traversal reached first would answer differently every run.

**Components are recomputed by a different algorithm.** `scripts/check_independent.py` uses
Kosaraju, two passes over the reversed graph, against the implementation's Tarjan. It re-extracts
the Python import graph with its own `ast` walk and its own resolver, applies every "remove these
edges" claim to confirm it really breaks the cycle, and exhaustively re-searches every claim
marked `proven` to catch a minimum that is not minimal. It imports nothing from the package, and
that is proved rather than asserted: it parses its own source with `ast`, follows every import
including `importlib.import_module` with a literal argument, and fails if anything it reaches is
outside the standard library. A grep for `require` would be satisfied by a comment.

**17 sabotages under the three-gate rule.** `scripts/sabotage.py` breaks the tool on purpose. A
sabotage counts only if it (1) applies and changes the file, (2) changes the measured output, and
(3) only then is caught. A null control runs first: an unmodified copy of the tree in a second
directory must fingerprint identically to the baseline, and if it does not the measurement tracks
where the code lives rather than what it does, gate 2 passes free for everything, and the run
aborts rather than reporting a score. Everything hashed is relative and version-free for that
reason.

One entry is filed as a **guard**, and guards invert gate 2. The HTML escaping in the JSON island
is dormant when module names are ordinary filenames, so disabling it cannot move the fingerprint
and demanding that it does would be demanding the impossible. For a guard the requirement is the
opposite and stricter: output unchanged, and the unit suite fails anyway. The harness also
reclassifies: a "guard" that does move the fingerprint was never dormant, and is reported as a
wrong classification rather than a pass.

Three findings came out of building that harness, and they are worth recording because in each
case the honest-looking conclusion was "the verify has a gap" and in each case it did not:

- Replacing `index.get(w)` with `low.get(w)` on a Tarjan back edge is the textbook slip and it is
  **not a bug**. Four hundred thousand random graphs produced no disagreement. For a node still on
  the stack, `low.get(w)` is bounded below by the root index of the component being built, so the
  root test lands in the same place. The low values differ, the components do not. The sabotage
  was replaced with one that corrupts the value handed to the parent frame on the pop, which is a
  real bug and splits any cycle longer than two modules.
- Two sabotages were no-ops because the corpus was too clean rather than because the checks were
  weak: every demo cycle was a pair, and every component was small enough for the exact feedback
  arc search. The fix was `py-triangle` and `py-tangle`, not a weaker check.
- One sabotage was a no-op because it patched genuinely dead code. `py_extract.py` computed
  `needs_binding` for `from` imports and `python.mjs` recomputed the same fact instead of reading
  it, so the field had two sources of truth and one of them was never consulted. Wiring the field
  through fixed that; the fingerprint before and after the fix is identical, which is how you know
  it was a refactor and not a behaviour change.

**A privacy scan with a positive control.** `scripts/privacy_scan.py` reads every tracked file as
bytes rather than handing it to grep, because one NUL byte makes git and grep classify a file as
binary and `grep -I` then skips it in silence. It fails if fewer than 30 files are tracked, since
before the first commit `git ls-files` returns nothing and a scan over nothing passes instantly.
It plants three credential-shaped strings in a real tracked file, reruns the whole scan, and fails
if they are not all found. The patterns are assembled from string fragments at run time, so this
file contains no complete credential-shaped string and needs no exemption for itself. That matters
in both directions: excluding the scanner's own path would buy silence on the pattern list at the
cost of going blind to a real leak in the same file, so there is no self-exclusion and a check
asserts the scanner's own path was among the files read.

It asks the NUL question of the committed blobs as well as the working tree, because what ships is
the commit. This project needed that: `test/fas.test.mjs` used a real NUL byte as a key separator,
which is correct code and not a mistake, and it had already been repaired on disk to the two
character escape `\0` while the object git held was still binary. Working tree clean, commit not.
Both halves of that check were run against a planted NUL to confirm they fire.

**The page is loaded in a real browser.** The unit tests import the renderer and never open the
page, so one unbalanced bracket in the inline script would leave all 177 green while the page
rendered as an empty shell. `scripts/browser_check.mjs` opens `docs/index.html` in Chromium and
asserts on things that only exist if the script parsed and ran: the cards, the severity tiles, the
filter buttons actually filtering, the search box actually searching. It checks layout at 390px by
walking elements and comparing each one's right edge against the viewport, ignoring anything
inside a container allowed to scroll sideways. The CSS deliberately does not contain
`body { overflow-x: hidden }`, which would hide real overflow and make the probe vacuous at the
same time, and the check fails if somebody adds it.

## What it found on real code

Run against 19 Python projects in the sibling `projects/` tree of this catalog: **zero cycles of
any rank** across all of them, 417 modules and 949 import edges. 22 imports across those 19
projects had a computed target and were declared unresolvable rather than dropped. That is the
useful negative control. Most small, well-factored Python has no cycles, and a tool that found
some anyway would be worthless.

Against libraries installed in system `dist-packages`:

| Library | Modules | Edges | Found |
|---|---|---|---|
| pygments | 321 | 799 | no cycles, 5 computed imports declared unresolvable |
| urllib3 | 32 | 163 | one **lazy** pair, `connection` and `response` |
| jinja2 | 25 | 194 | one **lazy** component of 17 modules, 4 computed imports declared |
| babel | 23 | 41 | two **lazy** pairs |
| attr | 22 | 50 | no cycles |
| requests | 18 | 63 | no cycles |
| yaml | 17 | 42 | no cycles |
| markupsafe | 3 | 8 | one **fragile** component of 3 |

Nothing anywhere came out as `breaks`, which is the result you want: all eight of these libraries
import without complaint, and a report calling any of them broken would be a report nobody reads
twice.

Two are worth spelling out. Jinja2 has a genuine 17-module tangle, and every one of the edges that
closes it is an import inside a function, so module evaluation never goes round the loop and the
rank is `lazy`. It is also the case that exercises the heuristic: 17 modules is far past the exact
search limit, so the five suggested edges are labelled as a heuristic answer with no minimality
claim. Markupsafe's `__init__.py` carries a comment reading `# circular import` directly above the
imports that close the loop, and `_native.py` reaches back for `Markup` at its line 3. It ranks
`fragile` rather than `breaks` because `Markup` is bound in `__init__.py` well above line 326,
which is the earliest point control can reach `_native`. That is the order-aware ranking doing the
job it exists for.

## Layout

```
bin/cycles.mjs             the CLI
src/scan.mjs               directory walk and ignore rules
src/py_extract.py          Python parsing, using Python's own ast
src/python.mjs             Python module resolution and edge semantics
src/typescript.mjs         TypeScript parsing via the real compiler, erasure and hoisting
src/scc.mjs                Tarjan, iterative, plus canonicalisation
src/fas.mjs                feedback arc set: exact below 22 arcs, Eades-Lin-Smyth above
src/analyze.mjs            ranking, order safety, and the report object
src/html.mjs               the self-contained page
fixtures/demo              a small two-language app with all four ranks, source of docs/index.html
fixtures/trees             20 trees with hand-written ground truth and runtime expectations
fixtures/graphs.json       15 synthetic graphs with hand-written components
scripts/verify.sh          the eleven steps above; its exit code is the result
scripts/sabotage.py        17 sabotages, three gates, null control first
scripts/check_independent.py   Kosaraju in Python, imports nothing from here
scripts/privacy_scan.py    credential and machine-path scan with a positive control
scripts/browser_check.mjs  loads the page in Chromium and measures inside it
scripts/fixture_truth.mjs  fixtures against ground truth and against the real runtimes
scripts/fingerprint.mjs    one digest over everything measured, for the sabotage harness
```

## Unfinished

- **Python only resolves imports within the scanned tree.** An import of an installed package is
  counted as external and ignored. A cycle that runs through a third-party package back into your
  code is invisible.
- **No re-export tracing through TypeScript path aliases.** `tsconfig.json` `paths` are not read,
  so an alias like `@app/thing` is treated as an external bare specifier. `.js` to `.ts` and
  directory-to-index resolution do work.
- **Conditional imports are treated as unconditional** unless they are under `if TYPE_CHECKING:`
  or `if __name__ == "__main__":`. An import inside `if sys.version_info >= (3, 11):` is an edge.
- **The heuristic threshold of 22 arcs is a guess** tuned so a fully connected 5-node component
  still gets an exact answer. It is not derived from a measured time budget.
- **No incremental mode.** Every run re-parses the whole tree.

## Status

Run on 2026-08-07 from a clean shell. Pasted output of `bash scripts/verify.sh`, exit 0.

```
$ bash scripts/verify.sh
import-cycle-report verify

------------------------------------------------------------------------
1/11 toolchain and repository preconditions
------------------------------------------------------------------------
  ok    node v24.13.0
  ok    Python 3.12.3
  ok    typescript is installed, so the real compiler parses the TypeScript fixtures
  ok    playwright-core is installed, so the page gets loaded in a real browser
  ok    inside a git repository, so the privacy scan has a file list to work from

[PASS] 1/11 toolchain and repository preconditions

------------------------------------------------------------------------
2/11 unit tests
------------------------------------------------------------------------
ℹ tests 177
ℹ suites 0
ℹ pass 177
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
  ok    177 tests passed, 0 failed

[PASS] 2/11 unit tests

------------------------------------------------------------------------
3/11 fixture trees against the real Python and Node runtimes
------------------------------------------------------------------------
  ok    py-clean: no cycles, as expected
  ok    py-clean: really imports cleanly
  ok    py-breaks: breaks:alpha.py+beta.py
  ok    py-breaks: really raises (ImportError: cannot import name 'ALPHA' from partially initialized module 'alpha' (most )
  ok    py-fragile: fragile:alpha.py+beta.py
  ok    py-fragile: really imports cleanly
  ok    py-lazy: lazy:alpha.py+beta.py
  ok    py-lazy: really imports cleanly
  ok    py-typing: types:alpha.py+beta.py
  ok    py-typing: really imports cleanly
  ok    py-pkg: breaks:pkgx/__init__.py+pkgx/leaf.py
  ok    py-pkg: really raises (ImportError: cannot import name 'SHARED' from partially initialized module 'pkgx' (most )
  ok    py-pkg-ordered: fragile:pkgy/__init__.py+pkgy/leaf.py
  ok    py-pkg-ordered: really imports cleanly
  ok    py-dynamic: lazy:alpha.py+beta.py
  ok    py-dynamic: really imports cleanly
  ok    py-triangle: breaks:alpha.py+beta.py+gamma.py
  ok    py-triangle: really raises (ImportError: cannot import name 'ALPHA' from partially initialized module 'alpha' (most )
  ok    py-tangle: fragile:m0.py+m1.py+m2.py+m3.py+m4.py+m5.py+m6.py+m7.py
  ok    py-tangle: really imports cleanly
  ok    ts-clean: no cycles, as expected
  ok    ts-clean: really imports cleanly
  ok    ts-breaks: breaks:a.mjs+b.mjs
  ok    ts-breaks: really raises (Node.js v24.13.0)
  ok    ts-fragile: fragile:a.mjs+b.mjs
  ok    ts-fragile: really imports cleanly
  ok    ts-hoisted: fragile:a.mjs+b.mjs
  ok    ts-hoisted: really imports cleanly
  ok    ts-lazy: lazy:a.mjs+b.mjs
  ok    ts-lazy: really imports cleanly
  ok    ts-types: types:a.ts+b.ts
  ok    ts-types: tsc really does emit no reference to ./b
  ok    ts-elided: types:a.ts+b.ts
  ok    ts-elided: tsc really does emit no reference to ./b
  ok    ts-barrel: fragile:index.mjs+widget.mjs
  ok    ts-barrel: really imports cleanly
  ok    ts-dynamic: lazy:a.mjs+b.mjs
  ok    ts-dynamic: really imports cleanly
  ok    ts-cjs: breaks:a.cjs+b.cjs
  ok    ts-cjs: really raises (Node.js v24.13.0)
  ok    both feedback arc methods were exercised: exact-exhaustive, heuristic-eades-lin-smyth
20 fixture trees agree with the hand written answer and with the runtime

[PASS] 3/11 fixture trees against the real Python and Node runtimes

------------------------------------------------------------------------
4/11 the command line tool end to end
------------------------------------------------------------------------
clean: 3 modules, 3 edges, 0 breaking, 0 fragile, 0 deferred, 0 types-only -> .verify-tmp/clean.html
  ok    a clean tree exits 0 with --fail-on types, the strictest setting
triangle: 3 modules, 3 edges, 1 breaking, 0 fragile, 0 deferred, 0 types-only -> .verify-tmp/tri.html
  ok    the three module cycle that really raises exits 1 with --fail-on breaks
fragile: 2 modules, 2 edges, 0 breaking, 1 fragile, 0 deferred, 0 types-only -> .verify-tmp/frag.html
  ok    an import time cycle that loads cleanly does not trip --fail-on breaks
  ok    the report is one self contained file of 16413 bytes
  ok    the report references nothing off the machine, so it survives being emailed

[PASS] 4/11 the command line tool end to end

------------------------------------------------------------------------
5/11 docs/index.html rebuilt from the demo tree and diffed
------------------------------------------------------------------------
docs/index.html: 32 modules, 25 edges, 3 breaking, 2 fragile, 3 deferred, 2 types-only, 2 unresolvable import(s)
  ok    docs/index.html regenerated byte for byte from the committed demo tree

[PASS] 5/11 docs/index.html rebuilt from the demo tree and diffed

------------------------------------------------------------------------
6/11 the published page loaded in a real browser
------------------------------------------------------------------------
  ok    the inline script ran to completion
  ok    10 cycle cards drawn, one per cycle in the embedded data
  ok    the severity tiles read 3/2/3/2, matching the data
  ok    the badges on the cards match the data: {"breaks":3,"fragile":2,"deferred":3,"types":2}
  ok    turning off one severity hid 3 card(s) and turning it back on restored them
  ok    search narrows the list and says so when nothing matches
  ok    the first card lists 2 import statement(s) and 1 edge(s) to remove
  ok    the card states which method produced the edge list
  ok    no sideways scroll at 1280px (1280 <= 1280)
  ok    all 10 cards still render at 390px
  ok    body overflow-x is visible, so overflow would be visible to this check
  ok    no sideways scroll at 390px (390 <= 390)
  ok    no element escapes the viewport at 390px
  ok    the page made no request off the filesystem
14 passed, 0 failed in a real browser via node_modules/playwright-core

[PASS] 6/11 the published page loaded in a real browser

------------------------------------------------------------------------
7/11 independent recomputation by a different algorithm
------------------------------------------------------------------------
demo: 32 modules, 25 edges, 3 breaking, 2 fragile, 3 deferred, 2 types-only -> .verify-tmp/demo.html
  ok    this checker reaches only the standard library (argparse, ast, itertools, json, os, sys), proved by walking its own imports with ast
  ok    Kosaraju finds 10 structural component(s) covering 21 module(s); every one of the tool's 21 is inside them
  ok    all 10 reported cycles are single components at their own level
  ok    10 'proven minimum' claim(s) re-searched exhaustively here and confirmed
  ok    an independent ast walk of the source finds 23 modules and 27 import pairs; every one of the 13 Python modules the tool put in a cycle is in one here too
independent recomputation agrees with the tool

[PASS] 7/11 independent recomputation by a different algorithm

------------------------------------------------------------------------
8/11 privacy scan with a positive control
------------------------------------------------------------------------
  ok    122 tracked files opened and read in full, nothing credential shaped
  ok    scripts/privacy_scan.py was scanned like every other file, with no self exclusion
  ok    no tracked file contains a NUL byte, so a grep based scan would see them all
  ok    no committed blob contains a NUL byte either, not just the working copy
  ok    the generated report has no machine path or credential in it
  ok    positive control: 3 planted strings all found in fixtures/privacy_control.txt, so the scan really reads tracked files
privacy scan clean, and proved able to find what it looks for

[PASS] 8/11 privacy scan with a positive control

------------------------------------------------------------------------
9/11 the tool run against real source
------------------------------------------------------------------------
this tool's own src: 7 modules, 8 edges, 0 breaking, 0 fragile, 0 deferred, 0 types-only -> .verify-tmp/self.html
  ok    analysed its own 7 module src/ tree
  ok    no path from the development machine reached the report

[PASS] 9/11 the tool run against real source

------------------------------------------------------------------------
10/11 sabotage under the three gate rule
------------------------------------------------------------------------
  baseline fingerprint 32dd1c75db6ae1b61c3d9fa1
  ok    null control: an untouched copy in a different directory digests identically
  ok    tarjan-lowlink-not-propagated-to-the-parent
          a cycle longer than two modules splits into pieces, because the lowlink a child found never reaches its parent
          changed: fingerprint 32dd1c75db6a -> de2f75073938
          caught by: unit suite, fixture truth, independent checker
  ok    two-module-cycles-ignored
          the commonest cycle of all, two modules importing each other, stops being reported
          changed: fingerprint 32dd1c75db6a -> aa72139dfcf0
          caught by: unit suite, fixture truth
  ok    exact-search-skipped-but-still-called-proven
          every answer comes from the heuristic while the report keeps its confidence
          changed: fingerprint 32dd1c75db6a -> c3310dc646f0
          caught by: unit suite, fixture truth
  ok    only-the-first-edge-of-the-fix-reported
          the advice no longer breaks the cycle it is advice about
          changed: fingerprint 32dd1c75db6a -> 91b1bc20d287
          caught by: unit suite
  ok    type-checking-blocks-treated-as-real-imports
          imports that never execute get counted, so working code is reported as broken
          changed: fingerprint 32dd1c75db6a -> fb0e8537d0c0
          caught by: unit suite, fixture truth
  ok    main-guard-imports-treated-as-real-imports
          the demo block under `if __name__ == "__main__"` becomes a real import edge
          changed: fingerprint 32dd1c75db6a -> 76580ddc0a8a
          caught by: unit suite
  ok    function-level-imports-treated-as-import-time
          the standard way of breaking a cycle stops being recognised
          changed: fingerprint 32dd1c75db6a -> ad18c0dd99b0
          caught by: unit suite, fixture truth
  ok    from-import-no-longer-needs-a-name
          the difference between a cycle that raises and one that does not disappears
          changed: fingerprint 32dd1c75db6a -> ce98bd521dcd
          caught by: unit suite, fixture truth
  ok    computed-importlib-silently-dropped
          an unresolvable import stops being declared, so the graph is incomplete in silence
          changed: fingerprint 32dd1c75db6a -> c377fa77f248
          caught by: unit suite
  ok    order-analysis-always-says-safe
          nothing is ever ranked as breaking, which is the failure mode that reads as good news
          changed: fingerprint 32dd1c75db6a -> bac899f6814e
          caught by: unit suite, fixture truth
  ok    parent-package-edges-treated-as-re-entrant
          every package becomes one giant strongly connected component again
          changed: fingerprint 32dd1c75db6a -> 148ec3db168e
          caught by: unit suite, fixture truth
  ok    import-type-treated-as-a-runtime-import
          erased imports are reported as runtime cycles, which sends people to break working code
          changed: fingerprint 32dd1c75db6a -> 6b28e1519c47
          caught by: unit suite
  ok    hoisting-forgotten
          a function declaration read across a cycle is called dangerous when it is not
          changed: fingerprint 32dd1c75db6a -> 76fb9f441476
          caught by: unit suite, fixture truth
  ok    dynamic-import-treated-as-eager
          await import() stops being a way out of a cycle
          changed: fingerprint 32dd1c75db6a -> fc8d2e0f194c
          caught by: unit suite, fixture truth
  ok    computed-dynamic-import-silently-dropped
          the report claims a complete graph when it knows it is missing an edge
          changed: fingerprint 32dd1c75db6a -> 2ac48923b573
          caught by: unit suite, fixture truth
  ok    html-embed-stops-escaping [guard]
          a module name containing markup can end the script tag and take over the page
          changed: output unchanged, as a dormant guard must be
          caught by: unit suite
  ok    html-attribute-escaping-removed
          every quote and angle bracket in a filename or a source line goes into the page raw. Classified as an attack and not a guard because it does move the fingerprint: the demo's import statements contain quotes, so the escaping is not dormant on correct input.
          changed: fingerprint 32dd1c75db6a -> 50eeaceb64d4
          caught by: unit suite
17 of 17 sabotages passed all three gates and were caught

[PASS] 10/11 sabotage under the three gate rule

------------------------------------------------------------------------
11/11 the README is finished and its numbers still match
------------------------------------------------------------------------
  ok    README.md has no stub marker left in it
  ok    README.md has a Status section
  ok    the Status section carries this script's own success line
  ok    the README's test count still says 177, which is what just ran

[PASS] 11/11 the README is finished and its numbers still match

------------------------------------------------------------------------
  ok    the run changed no tracked file, so its result is a fact about the code
------------------------------------------------------------------------
VERIFY PASSED: 11 of 11 steps
```

## License

MIT
