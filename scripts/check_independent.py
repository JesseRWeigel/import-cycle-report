#!/usr/bin/env python3
"""Recompute the answers by a different route, sharing no code with the tool.

This imports nothing from the package under test. It is Python, the tool is JavaScript, and the
last check in here proves the independence rather than asserting it: it parses its own source with
`ast`, follows every import, and fails if anything it reaches is not in the standard library. A
grep for "require" would be satisfied by a comment and would miss `importlib.import_module`.

What it recomputes, and how it differs:

  components   Kosaraju, not Tarjan. Two passes over the graph, the second over the reversed
               edges in reverse finishing order. Tarjan is one pass with lowlink bookkeeping.
               Different data structures, different invariants, same answer or somebody is wrong.

  the graph    Re-extracted from the Python sources with this file's own `ast` walk and its own
               module resolver. If the tool's resolver invents an edge, the module it invented a
               cycle for will not be in a cycle here.

  the fix      Every "remove these edges" claim is applied to the graph and the result re-checked
               for cycles. Every claim marked `proven` is re-searched exhaustively here, so a
               tool that says "minimum" about a set that is not minimum gets caught.
"""

import argparse
import ast
import json
import os
import sys
from itertools import combinations


# --------------------------------------------------------------------------- components


def kosaraju(nodes, edges):
    """Strongly connected components, by the two pass reversed graph method."""
    out_adj = {n: [] for n in nodes}
    in_adj = {n: [] for n in nodes}
    for a, b in edges:
        out_adj.setdefault(a, []).append(b)
        in_adj.setdefault(b, []).append(a)
        out_adj.setdefault(b, out_adj.get(b, []))
        in_adj.setdefault(a, in_adj.get(a, []))

    order = []
    seen = set()
    for start in out_adj:
        if start in seen:
            continue
        stack = [(start, iter(out_adj[start]))]
        seen.add(start)
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append((nxt, iter(out_adj.get(nxt, []))))
                    advanced = True
                    break
            if not advanced:
                order.append(stack.pop()[0])

    assigned = {}
    comps = []
    for node in reversed(order):
        if node in assigned:
            continue
        comp = []
        stack = [node]
        assigned[node] = len(comps)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for prev in in_adj.get(cur, []):
                if prev not in assigned:
                    assigned[prev] = len(comps)
                    stack.append(prev)
        comps.append(sorted(comp))
    return comps


def cyclic_components(nodes, edges):
    loops = {a for a, b in edges if a == b}
    return sorted(
        (c for c in kosaraju(nodes, edges) if len(c) > 1 or c[0] in loops),
        key=lambda c: (-len(c), c[0]),
    )


def is_acyclic(nodes, edges):
    return not cyclic_components(nodes, edges)


# --------------------------------------------------------------------------- own extraction

IGNORE_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".nox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".nuxt", ".svelte-kit",
    "dist", "build", "out", "coverage", ".cache", "vendor", "site-packages",
}


def walk_python(root):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")
        ]
        for f in filenames:
            if f.endswith(".py") or f.endswith(".pyi"):
                found.append(os.path.join(dirpath, f))
    return sorted(found)


def dotted_names(root, paths):
    """Every file's dotted module name, climbing out of packages the way sys.path would."""
    is_pkg_cache = {}

    def is_pkg(d):
        if d not in is_pkg_cache:
            is_pkg_cache[d] = os.path.isfile(os.path.join(d, "__init__.py"))
        return is_pkg_cache[d]

    root_prefix = [os.path.basename(os.path.abspath(root))] if is_pkg(root) else []
    by_dotted = {}
    info = {}
    for p in paths:
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        parts = rel.split("/")
        stem = parts[-1].rsplit(".", 1)[0]
        chain = []
        cursor = parts[:-1]
        while cursor and is_pkg(os.path.join(root, *cursor)):
            chain.insert(0, cursor[-1])
            cursor = cursor[:-1]
        pieces = root_prefix + chain + ([] if stem == "__init__" else [stem])
        dotted = ".".join(pieces)
        if not dotted:
            continue
        if dotted not in by_dotted or len(rel) < len(by_dotted[dotted]):
            by_dotted[dotted] = rel
        info[rel] = {
            "dotted": dotted,
            "pkg": dotted if stem == "__init__" else ".".join(root_prefix + chain),
        }
    return by_dotted, info


def all_import_targets(root):
    """
    Every (from, to) pair implied by any import statement anywhere in any file.

    Deliberately generous. Guards, scopes and package parents are all ignored, so this is a
    superset of what the tool reports. That makes it useful in one direction: anything the tool
    claims is in a cycle had better be in a cycle here too, or the tool made an edge up.
    """
    paths = walk_python(root)
    by_dotted, info = dotted_names(root, paths)
    nodes = sorted(info)
    pairs = set()
    for p in paths:
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        if rel not in info:
            continue
        try:
            tree = ast.parse(open(p, "rb").read().decode("utf-8", "replace"), filename=p)
        except SyntaxError:
            continue
        pkg = info[rel]["pkg"]
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.Import):
                for alias in node.names:
                    targets.append((alias.name, []))
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    anchor = pkg.split(".") if pkg else []
                    up = node.level - 1
                    if up > len(anchor):
                        continue
                    anchor = anchor[: len(anchor) - up] if up else anchor
                    base = ".".join(anchor + (node.module.split(".") if node.module else []))
                targets.append((base, [a.name for a in node.names if a.name != "*"]))
            for base, names in targets:
                if not base:
                    continue
                parts = base.split(".")
                for i in range(1, len(parts) + 1):
                    hit = by_dotted.get(".".join(parts[:i]))
                    if hit and hit != rel:
                        pairs.add((rel, hit))
                for n in names:
                    hit = by_dotted.get(f"{base}.{n}")
                    if hit and hit != rel:
                        pairs.add((rel, hit))
    return nodes, sorted(pairs)


# --------------------------------------------------------------------------- self independence


def prove_no_shared_code(script_path):
    """
    Walk this file's own import graph with ast and require everything it reaches to be stdlib.

    A checker that imports the thing it checks inherits its bugs. This is the check that the
    checker is what it says it is, and it is done by parsing rather than by grepping, because
    `importlib.import_module("src.analyze")` contains no import keyword at all.
    """
    stdlib = getattr(sys, "stdlib_module_names", frozenset())
    if not stdlib:
        return ["this Python is too old to know its own stdlib module list"]
    seen = set()
    queue = [os.path.abspath(script_path)]
    problems = []
    reached = []
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        tree = ast.parse(open(path, "rb").read().decode("utf-8"), filename=path)
        names = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names += [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    problems.append(f"{os.path.basename(path)} uses a relative import")
                elif node.module:
                    names.append(node.module)
            elif isinstance(node, ast.Call):
                func = node.func
                is_dynamic = (
                    isinstance(func, ast.Attribute) and func.attr == "import_module"
                ) or (isinstance(func, ast.Name) and func.id in ("import_module", "__import__"))
                if is_dynamic:
                    if node.args and isinstance(node.args[0], ast.Constant):
                        names.append(node.args[0].value)
                    else:
                        problems.append(
                            f"{os.path.basename(path)} imports a computed module name, so this "
                            "proof cannot be completed"
                        )
        for name in names:
            top = name.split(".")[0]
            reached.append(top)
            if top in stdlib:
                continue
            sibling = os.path.join(os.path.dirname(path), *name.split(".")) + ".py"
            if os.path.isfile(sibling):
                queue.append(sibling)
                problems.append(f"{os.path.basename(path)} imports local module {name}")
            else:
                problems.append(f"{os.path.basename(path)} imports non stdlib module {name}")
    return problems, sorted(set(reached))


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="report written with --include-graph")
    ap.add_argument("--root", help="the analysed tree, for an independent re-extraction")
    ap.add_argument("--max-exact", type=int, default=16)
    args = ap.parse_args()

    report = json.load(open(args.json))
    failures = []
    notes = []

    def bad(msg):
        failures.append(msg)
        print(f"  FAIL  {msg}")

    def good(msg):
        print(f"  ok    {msg}")

    problems, reached = prove_no_shared_code(__file__)
    if problems:
        for p in problems:
            bad(f"independence: {p}")
    else:
        good(
            f"this checker reaches only the standard library ({', '.join(reached)}), "
            "proved by walking its own imports with ast"
        )

    graph = report.get("graph")
    if not graph:
        bad("the report has no graph in it. Re-run the tool with --include-graph.")
        print(f"{len(failures)} independent check(s) failed")
        return 1

    nodes = graph["nodes"]
    all_pairs = [(e["from"], e["to"]) for e in graph["edges"]]
    runtime_pairs = [(e["from"], e["to"]) for e in graph["edges"] if e["timing"] == "import-time"]
    code_pairs = [(e["from"], e["to"]) for e in graph["edges"] if e["timing"] != "erased"]

    # 1. Kosaraju over the tool's own graph must find the same structural components.
    mine = cyclic_components(nodes, all_pairs)
    mine_nodes = {n for c in mine for n in c}
    theirs_nodes = {n for c in report["cycles"] for n in c["nodes"]}
    if not theirs_nodes <= mine_nodes:
        extra = sorted(theirs_nodes - mine_nodes)[:6]
        bad(f"the tool reported modules in cycles that Kosaraju does not agree are in one: {extra}")
    else:
        good(
            f"Kosaraju finds {len(mine)} structural component(s) covering {len(mine_nodes)} "
            f"module(s); every one of the tool's {len(theirs_nodes)} is inside them"
        )

    # 2. Each reported set really is strongly connected in the graph it was drawn from.
    for c in report["cycles"]:
        pairs = {"breaks": runtime_pairs, "fragile": runtime_pairs}.get(
            c["severity"], code_pairs if c["severity"] == "lazy" else all_pairs
        )
        inside = [(a, b) for a, b in pairs if a in set(c["nodes"]) and b in set(c["nodes"])]
        comps = cyclic_components(c["nodes"], inside)
        if len(comps) != 1 or sorted(comps[0]) != sorted(c["nodes"]):
            bad(
                f"cycle {c['id']} ({c['severity']}) is not one strongly connected component "
                f"of the {c['severity']} graph: {comps}"
            )
    if not failures:
        good(f"all {len(report['cycles'])} reported cycles are single components at their own level")

    # 3. The suggested edge removals really do break each cycle.
    for c in report["cycles"]:
        node_set = set(c["nodes"])
        inside = [
            (e["from"], e["to"])
            for e in c["edges"]
            if e["from"] in node_set and e["to"] in node_set
        ]
        drop = {(a["from"], a["to"]) for a in c["break"]["arcs"]}
        left = [p for p in set(inside) if p not in drop]
        if not is_acyclic(c["nodes"], left):
            bad(f"cycle {c['id']}: removing the named edges leaves a cycle behind")

    # 4. Anything claiming to be minimum is re-searched here.
    proven = 0
    for c in report["cycles"]:
        if not c["break"]["proven"]:
            continue
        node_set = set(c["nodes"])
        arcs = sorted({(e["from"], e["to"]) for e in c["edges"] if e["from"] in node_set and e["to"] in node_set})
        k = len(c["break"]["arcs"])
        if len(arcs) > args.max_exact:
            notes.append(f"cycle {c['id']} claims a proven minimum over {len(arcs)} arcs, not re-searched here")
            continue
        found_smaller = None
        for size in range(0, k):
            for combo in combinations(range(len(arcs)), size):
                left = [a for i, a in enumerate(arcs) if i not in set(combo)]
                if is_acyclic(c["nodes"], left):
                    found_smaller = [arcs[i] for i in combo]
                    break
            if found_smaller:
                break
        if found_smaller is not None:
            bad(
                f"cycle {c['id']}: the tool says {k} edges is the minimum, but "
                f"{len(found_smaller)} works: {found_smaller}"
            )
        else:
            proven += 1
    if proven:
        good(f"{proven} 'proven minimum' claim(s) re-searched exhaustively here and confirmed")

    # 5. Re-extract the graph from source and check the tool did not invent a cycle.
    if args.root:
        own_nodes, own_pairs = all_import_targets(args.root)
        own_cycles = cyclic_components(own_nodes, own_pairs)
        own_in_cycles = {n for c in own_cycles for n in c}
        py_claimed = {
            n
            for c in report["cycles"]
            for n in c["nodes"]
            if n.endswith(".py") or n.endswith(".pyi")
        }
        invented = sorted(py_claimed - own_in_cycles)
        if invented:
            bad(
                "the tool put these Python modules in a cycle and an independent re-extraction "
                f"does not: {invented[:6]}"
            )
        else:
            good(
                f"an independent ast walk of the source finds {len(own_nodes)} modules and "
                f"{len(own_pairs)} import pairs; every one of the {len(py_claimed)} Python "
                "modules the tool put in a cycle is in one here too"
            )

    for n in notes:
        print(f"  note  {n}")
    if failures:
        print(f"{len(failures)} independent check(s) failed")
        return 1
    print("independent recomputation agrees with the tool")
    return 0


if __name__ == "__main__":
    sys.exit(main())
