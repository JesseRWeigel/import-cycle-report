#!/usr/bin/env python3
"""Break the tool on purpose and check that something notices.

THREE GATES. A sabotage counts only if all three hold, in order:

  1. IT APPLIES.  The text being replaced is actually in the file, and the replacement differs
     from it. `KNOWN = [] or [...]` evaluates to the second operand, so the list is never emptied,
     and the confident write-up that follows is about nothing.

  2. IT CHANGES THE MEASURED OUTPUT.  scripts/fingerprint.mjs digests the demo report, the
     rendered page and the ranking of every fixture tree. If the digest does not move, the code
     that was broken is code nothing exercises, and a passing test afterwards proves nothing about
     the test. Patching a field the renderer does not read is the classic version of this.

  3. ONLY THEN, SOMETHING CATCHES IT.  The unit suite, the fixture truth harness, or the
     independent Python checker has to fail.

NULL CONTROL, run first. An unmodified copy of the tree in a different directory must digest to
exactly the baseline. If it does not, the measurement is tracking the working directory rather
than the code, gate 2 passes for free for every attack, and the whole run is void.

GUARDS INVERT GATE 2. Some of this code is dormant when the input is well behaved. The HTML
escaping never fires on a demo tree whose module names are ordinary filenames, so disabling it
cannot move the fingerprint, and demanding that it does would be demanding the impossible. For
those entries the requirement is the opposite and stricter: the measured output must be UNCHANGED
and the unit suite must FAIL anyway. A "guard" that does move the fingerprint was never dormant
and is rerun here as a plain attack, because the classification was wrong.

Two entries were removed rather than kept, and the reasons are worth recording:

  Replacing `index.get(w)` with `low.get(w)` on a Tarjan back edge is the textbook slip, and it
  is not a bug. Four hundred thousand random graphs produced no disagreement between the two, and
  the reason is that for a node still on the stack, `low.get(w)` is bounded below by the root
  index of the component being built, so the root test `low === index` lands in the same place.
  The low values differ, the components do not. Corrupting the value handed to the PARENT frame on
  the pop is a real bug, and that is what the first entry below does now.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# (name, file, old text, new text, one line on what the change means, optional mode)
# mode is "attack" by default: the output must move and something must catch it.
# mode "guard" is for code that is dormant on correct input: the output must NOT move, and the
# unit suite must fail anyway.
SABOTAGES = [
    (
        "tarjan-lowlink-not-propagated-to-the-parent",
        "src/scc.mjs",
        "        low.set(parent, Math.min(low.get(parent), low.get(v)));",
        "        low.set(parent, Math.min(low.get(parent), index.get(v)));",
        "a cycle longer than two modules splits into pieces, because the lowlink a child found "
        "never reaches its parent",
    ),
    (
        "two-module-cycles-ignored",
        "src/scc.mjs",
        "  return canonicalComponents(nodes, edges).filter((c) => c.length > 1 || loops.has(c[0]));",
        "  return canonicalComponents(nodes, edges).filter((c) => c.length > 2 || loops.has(c[0]));",
        "the commonest cycle of all, two modules importing each other, stops being reported",
    ),
    (
        "exact-search-skipped-but-still-called-proven",
        "src/fas.mjs",
        "  if (arcs.length <= exactMaxArcs) {",
        "  if (arcs.length <= 0) {",
        "every answer comes from the heuristic while the report keeps its confidence",
    ),
    (
        "only-the-first-edge-of-the-fix-reported",
        "src/fas.mjs",
        "    arcs: [...candidate].sort((a, b) => a - b).map((i) => arcs[i]),",
        "    arcs: [...candidate].sort((a, b) => a - b).slice(0, 1).map((i) => arcs[i]),",
        "the advice no longer breaks the cycle it is advice about",
    ),
    (
        "type-checking-blocks-treated-as-real-imports",
        "src/py_extract.py",
        '        if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING":',
        '        if isinstance(test, ast.Name) and test.id == "NEVER_MATCHES_ANYTHING":',
        "imports that never execute get counted, so working code is reported as broken",
    ),
    (
        "main-guard-imports-treated-as-real-imports",
        "src/py_extract.py",
        "        has_main = any(",
        "        has_main = False and any(",
        'the demo block under `if __name__ == "__main__"` becomes a real import edge',
    ),
    (
        "function-level-imports-treated-as-import-time",
        "src/py_extract.py",
        "        if self.main_guard_depth > 0 or self.func_depth > 0:",
        "        if self.main_guard_depth > 0 or self.func_depth > 99:",
        "the standard way of breaking a cycle stops being recognised",
    ),
    (
        "from-import-no-longer-needs-a-name",
        "src/py_extract.py",
        '            # `from a import thing` reads an attribute off a module that may be halfway loaded.\n'
        '            imp["needs_binding"] = True',
        '            imp["needs_binding"] = False',
        "the difference between a cycle that raises and one that does not disappears",
    ),
    (
        "computed-importlib-silently-dropped",
        "src/py_extract.py",
        '                        "reason": "import target is computed at runtime, so it cannot be resolved",',
        '                        "reason": "",\n                    }\n                ) if False else self.dynamic.append(\n                    {\n                        "line": node.lineno,\n                        "reason": "unused",',
        "an unresolvable import stops being declared, so the graph is incomplete in silence",
    ),
    (
        "order-analysis-always-says-safe",
        "src/analyze.mjs",
        "function orderSafety(edge, coreEdges, bindings, hoisted) {\n  if (!edge.needsBinding) return { safe: true, why: null };",
        "function orderSafety(edge, coreEdges, bindings, hoisted) {\n  if (true) return { safe: true, why: 'sabotaged' };\n  if (!edge.needsBinding) return { safe: true, why: null };",
        "nothing is ever ranked as breaking, which is the failure mode that reads as good news",
    ),
    (
        "parent-package-edges-treated-as-re-entrant",
        "src/python.mjs",
        "export function isAncestorPackage(selfPkg, prefix) {\n  if (!selfPkg || !prefix) return false;",
        "export function isAncestorPackage(selfPkg, prefix) {\n  if (selfPkg || prefix) return false;",
        "every package becomes one giant strongly connected component again",
    ),
    (
        "import-type-treated-as-a-runtime-import",
        "src/typescript.mjs",
        "        } else if (clause.isTypeOnly) {",
        "        } else if (clause.isTypeOnly && false) {",
        "erased imports are reported as runtime cycles, which sends people to break working code",
    ),
    (
        "hoisting-forgotten",
        "src/typescript.mjs",
        "      if (isExported(node)) hoisted.add(isDefault(node) ? 'default' : node.name.text);",
        "      if (isExported(node) && false) hoisted.add(node.name.text);",
        "a function declaration read across a cycle is called dangerous when it is not",
    ),
    (
        "dynamic-import-treated-as-eager",
        "src/typescript.mjs",
        "              timing: 'deferred',\n              kind: 'dynamic-import',",
        "              timing: 'import-time',\n              kind: 'dynamic-import',",
        "await import() stops being a way out of a cycle",
    ),
    (
        "computed-dynamic-import-silently-dropped",
        "src/typescript.mjs",
        "        } else if (arg) {\n          dynamic.push({",
        "        } else if (arg && false) {\n          dynamic.push({",
        "the report claims a complete graph when it knows it is missing an edge",
    ),
    (
        "html-embed-stops-escaping",
        "src/html.mjs",
        "  return JSON.stringify(obj)\n    .replace(/</g, '\\\\u003c')",
        "  return JSON.stringify(obj)\n    .replace(/</g, '<')",
        "a module name containing markup can end the script tag and take over the page",
        "guard",
    ),
    (
        "html-attribute-escaping-removed",
        "src/html.mjs",
        "function esc(s) {\n  return String(s)\n    .replace(/&/g, '&amp;')",
        "function esc(s) {\n  return String(s);\n  return String(s)\n    .replace(/&/g, '&amp;')",
        "every quote and angle bracket in a filename or a source line goes into the page raw. "
        "Classified as an attack and not a guard because it does move the fingerprint: the demo's "
        "import statements contain quotes, so the escaping is not dormant on correct input.",
    ),
]


def run(cmd, cwd, timeout=600):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def copy_tree(dest):
    shutil.copytree(
        ROOT,
        dest,
        ignore=shutil.ignore_patterns(
            ".git", "node_modules", "__pycache__", "*.pyc", ".verify-tmp"
        ),
    )
    # node_modules is symlinked rather than copied: 30 MB times sixteen attacks is pointless IO,
    # and the dependency is not what is being sabotaged.
    src_modules = os.path.join(ROOT, "node_modules")
    if os.path.isdir(src_modules):
        os.symlink(src_modules, os.path.join(dest, "node_modules"))


def fingerprint(cwd):
    res = run(["node", "scripts/fingerprint.mjs"], cwd)
    if res.returncode != 0:
        return f"TOOL-FAILED:{hashlib.sha256((res.stderr or '').encode()).hexdigest()[:16]}", res
    return res.stdout.strip(), res


def apply_patch(path, old, new):
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if old == new:
        return "the sabotage is a no-op: old and new text are identical"
    if old not in text:
        return f"the text to replace is not in {os.path.basename(path)}"
    if text.count(old) > 1:
        return f"the text to replace appears {text.count(old)} times, so the patch is ambiguous"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text.replace(old, new, 1))
    return None


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    work = tempfile.mkdtemp(prefix="icr-sabotage-")
    caught = 0
    problems = []
    try:
        baseline_dir = os.path.join(work, "baseline")
        copy_tree(baseline_dir)
        baseline, res = fingerprint(baseline_dir)
        if baseline.startswith("TOOL-FAILED"):
            print("  FAIL  the unmodified tree does not even run:")
            print((res.stderr or "")[:600])
            return 1
        print(f"  baseline fingerprint {baseline[:24]}")

        # ---- null control ----------------------------------------------------------------
        null_dir = os.path.join(work, "null-control")
        copy_tree(null_dir)
        null_fp, _ = fingerprint(null_dir)
        if null_fp != baseline:
            print("  FAIL  NULL CONTROL: an unmodified copy fingerprints differently")
            print(f"        baseline {baseline}")
            print(f"        copy     {null_fp}")
            print(
                "        The measurement depends on where the tree sits, so every sabotage would\n"
                "        pass gate 2 for free and this whole run would be meaningless. Aborting."
            )
            return 1
        print("  ok    null control: an untouched copy in a different directory digests identically")

        for entry in SABOTAGES:
            name, rel, old, new, meaning = entry[:5]
            mode = entry[5] if len(entry) > 5 else "attack"
            if only and only not in name:
                continue
            work_dir = os.path.join(work, name)
            copy_tree(work_dir)

            # gate 1
            err = apply_patch(os.path.join(work_dir, rel), old, new)
            if err:
                print(f"  FAIL  {name}: DID NOT APPLY, {err}")
                problems.append(name)
                continue

            # gate 2
            fp, fres = fingerprint(work_dir)
            if mode == "guard":
                # Dormant code cannot move the output, so the requirement is reversed.
                if fp != baseline:
                    print(f"  FAIL  {name}: filed as a guard, but disabling it moved the output")
                    print(
                        "        A guard is code that does nothing when the input is well behaved. "
                        "This one\n        was doing something, so the classification is wrong. "
                        "Rerun it as a plain attack."
                    )
                    problems.append(name)
                    continue
                changed = "output unchanged, as a dormant guard must be"
            elif fp == baseline:
                print(f"  FAIL  {name}: applied but the measured output is byte identical.")
                print("        Nothing was really sabotaged, so no conclusion can be drawn.")
                print(
                    "        Either the corpus never exercises this code, in which case the fix "
                    "is a fixture\n        that does, or the change has no effect and the check it "
                    "was aimed at is fine."
                )
                problems.append(name)
                continue
            else:
                changed = (
                    "the tool itself now fails to run"
                    if fp.startswith("TOOL-FAILED")
                    else f"fingerprint {baseline[:12]} -> {fp[:12]}"
                )

            # gate 3
            detectors = {}
            detectors["unit suite"] = run(
                ["node", "--test", "test/scc.test.mjs", "test/fas.test.mjs",
                 "test/python.test.mjs", "test/typescript.test.mjs", "test/report.test.mjs"],
                work_dir,
            ).returncode
            detectors["fixture truth"] = run(["node", "scripts/fixture_truth.mjs"], work_dir).returncode
            report = os.path.join(work_dir, "sabotage-report.json")
            gen = run(
                ["node", "bin/cycles.mjs", "fixtures/demo", "--label", "demo", "--include-graph",
                 "--json", report, "--out", os.path.join(work_dir, "sabotage.html"),
                 "--fail-on", "never", "--quiet"],
                work_dir,
            )
            if gen.returncode not in (0, 1) or not os.path.isfile(report):
                detectors["independent checker"] = 1
            else:
                detectors["independent checker"] = run(
                    ["python3", "scripts/check_independent.py", "--json", report,
                     "--root", "fixtures/demo"],
                    work_dir,
                ).returncode

            noticed = [k for k, v in detectors.items() if v != 0]
            if mode == "guard" and detectors["unit suite"] == 0:
                # For a guard the unit suite is the only detector that can speak, because the
                # output the other two read is by definition unchanged.
                noticed = []
            print(f"  {'ok   ' if noticed else 'FAIL '} {name}{' [guard]' if mode == 'guard' else ''}")
            print(f"          {meaning}")
            print(f"          changed: {changed}")
            if noticed:
                print(f"          caught by: {', '.join(noticed)}")
                caught += 1
            elif mode == "guard":
                print("          NOTHING NOTICED. The guard was disabled and the unit suite, which")
                print("          is the only check that feeds it hostile input, stayed green.")
                problems.append(name)
            else:
                print("          NOTHING NOTICED. The output moved and every check stayed green.")
                problems.append(name)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    total = len([s for s in SABOTAGES if not only or only in s[0]])
    print(f"{caught} of {total} sabotages passed all three gates and were caught")
    if problems:
        print(f"unproven: {', '.join(problems)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
