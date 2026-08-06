#!/usr/bin/env python3
"""Extract import statements from Python files using the ast module.

Reads a NUL separated list of absolute paths on stdin, writes one JSON document to stdout.

This parses. It does not grep. The difference shows up immediately on real code:

  * `import x` inside a function body does not run until the function is called, so it cannot
    participate in a module evaluation cycle. A grep sees the same line either way.
  * `if TYPE_CHECKING:` blocks never execute. The import is real to a type checker and absent at
    runtime, and a tool that flags those cycles is telling you to break code that works.
  * `importlib.import_module("a.b")` is an import with a literal target and should be an edge.
    `importlib.import_module(name)` is an import whose target this tool cannot know, and the
    honest thing is to say the graph is incomplete and name the file, not to drop it quietly.
  * A string in a docstring that happens to read `import foo` is not an import.

The other thing recorded here is whether the import needs a NAME out of the other module at the
moment it runs. `from a import thing` does: if `a` is halfway through its own import, `thing` may
not exist yet and Python raises ImportError. Plain `import a` does not, because it binds the
module object, which exists in sys.modules from the start. That distinction is the whole
difference between a cycle that works and a cycle that crashes on startup, so it is measured per
statement rather than assumed.
"""

import ast
import json
import sys

IMPORT_TIME = "import-time"
DEFERRED = "deferred"
ERASED = "erased"


class Collector(ast.NodeVisitor):
    def __init__(self, source):
        self.source = source
        self.imports = []
        self.dynamic = []
        self.func_depth = 0
        self.type_checking_depth = 0
        self.conditional_depth = 0
        self.annotation_depth = 0
        self.future_annotations = False
        # Names read while the module body is executing. A plain `import a` becomes dangerous
        # exactly when something touches `a` before the module finishes loading.
        self.import_time_names = set()

    # -- helpers ---------------------------------------------------------------------------

    def timing(self):
        if self.type_checking_depth > 0:
            return ERASED
        if self.func_depth > 0:
            return DEFERRED
        return IMPORT_TIME

    def segment(self, node):
        try:
            text = ast.get_source_segment(self.source, node) or ""
        except Exception:
            text = ""
        return " ".join(text.split())[:160]

    def in_module_body(self):
        return self.func_depth == 0 and self.type_checking_depth == 0

    # -- scopes ----------------------------------------------------------------------------

    def _visit_function(self, node):
        # Decorators, default arguments and the return annotation are evaluated where the `def`
        # sits, which for a module level function is import time. Only the body is deferred.
        for dec in node.decorator_list:
            self.visit(dec)
        args = node.args
        for d in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            self.visit(d)
        for a in (
            list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
            + ([args.vararg] if args.vararg else []) + ([args.kwarg] if args.kwarg else [])
        ):
            if a.annotation is not None:
                self.annotation_depth += 1
                self.visit(a.annotation)
                self.annotation_depth -= 1
        if node.returns is not None:
            self.annotation_depth += 1
            self.visit(node.returns)
            self.annotation_depth -= 1
        self.func_depth += 1
        for stmt in node.body:
            self.visit(stmt)
        self.func_depth -= 1

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node):
        for d in list(node.args.defaults) + [d for d in node.args.kw_defaults if d is not None]:
            self.visit(d)
        self.func_depth += 1
        self.visit(node.body)
        self.func_depth -= 1

    def visit_ClassDef(self, node):
        # A class body runs at import time, so nothing changes about depth here. The base class
        # expression in particular is evaluated immediately, which is why `class B(a.A)` after a
        # plain `import a` can fail inside a cycle while the same code inside a method cannot.
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        self.visit(node.target)
        if node.annotation is not None:
            self.annotation_depth += 1
            self.visit(node.annotation)
            self.annotation_depth -= 1
        if node.value is not None:
            self.visit(node.value)

    @staticmethod
    def _is_type_checking(test):
        if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING":
            return True
        if isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING":
            return True
        if isinstance(test, ast.Constant) and test.value is False:
            return True
        return False

    def visit_If(self, node):
        self.visit(node.test)
        guarded = self._is_type_checking(node.test)
        if guarded:
            self.type_checking_depth += 1
        else:
            self.conditional_depth += 1
        for stmt in node.body:
            self.visit(stmt)
        if guarded:
            self.type_checking_depth -= 1
        else:
            self.conditional_depth -= 1
        self.conditional_depth += 1
        for stmt in node.orelse:
            self.visit(stmt)
        self.conditional_depth -= 1

    def visit_Try(self, node):
        self.conditional_depth += 1
        self.generic_visit(node)
        self.conditional_depth -= 1

    visit_TryStar = visit_Try

    # -- imports ---------------------------------------------------------------------------

    def visit_Import(self, node):
        for alias in node.names:
            bound = alias.asname if alias.asname else alias.name.split(".")[0]
            self.imports.append(
                {
                    "kind": "import",
                    "module": alias.name,
                    "level": 0,
                    "names": [],
                    "star": False,
                    "line": node.lineno,
                    "timing": self.timing(),
                    "conditional": self.conditional_depth > 0,
                    "binding": bound,
                    "text": self.segment(node),
                }
            )

    def visit_ImportFrom(self, node):
        star = any(a.name == "*" for a in node.names)
        if node.module == "__future__" and any(a.name == "annotations" for a in node.names):
            self.future_annotations = True
        self.imports.append(
            {
                "kind": "from",
                "module": node.module,
                "level": node.level or 0,
                "names": [
                    {"name": a.name, "asname": a.asname} for a in node.names if a.name != "*"
                ],
                "star": star,
                "line": node.lineno,
                "timing": self.timing(),
                "conditional": self.conditional_depth > 0,
                "binding": None,
                "text": self.segment(node),
            }
        )

    def visit_Call(self, node):
        target = None
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "import_module":
            target = "importlib"
        elif isinstance(func, ast.Name) and func.id == "import_module":
            target = "importlib"
        elif isinstance(func, ast.Name) and func.id == "__import__":
            target = "dunder"
        if target is not None and node.args:
            first = node.args[0]
            package = None
            if target == "importlib" and len(node.args) > 1:
                package = node.args[1]
            for kw in node.keywords:
                if kw.arg == "package":
                    package = kw.value
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                name = first.value
                level = len(name) - len(name.lstrip("."))
                relative_ok = level == 0 or (
                    isinstance(package, ast.Constant) and isinstance(package.value, str)
                ) or package is None
                if level > 0 and not relative_ok:
                    self.dynamic.append(
                        {
                            "line": node.lineno,
                            "reason": "relative importlib.import_module with a computed package",
                            "text": self.segment(node),
                        }
                    )
                else:
                    self.imports.append(
                        {
                            "kind": "importlib",
                            "module": name.lstrip(".") or None,
                            "level": level,
                            "names": [],
                            "star": False,
                            "line": node.lineno,
                            "timing": self.timing(),
                            "conditional": self.conditional_depth > 0,
                            "binding": None,
                            "text": self.segment(node),
                        }
                    )
            else:
                self.dynamic.append(
                    {
                        "line": node.lineno,
                        "reason": "import target is computed at runtime, so it cannot be resolved",
                        "text": self.segment(node),
                    }
                )
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and self.in_module_body():
            if not (self.annotation_depth > 0 and self.future_annotations):
                self.import_time_names.add(node.id)
        self.generic_visit(node)


def extract(path):
    try:
        raw = open(path, "rb").read()
    except OSError as exc:
        return {"parse_error": f"could not read: {exc}", "imports": [], "dynamic": []}
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            source = raw.decode("latin-1")
        except Exception as exc:  # pragma: no cover
            return {"parse_error": f"undecodable: {exc}", "imports": [], "dynamic": []}
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        return {
            "parse_error": f"syntax error at line {exc.lineno}: {exc.msg}",
            "imports": [],
            "dynamic": [],
        }
    collector = Collector(source)
    collector.visit(tree)
    for imp in collector.imports:
        if imp["kind"] == "from":
            # `from a import thing` reads an attribute off a module that may be halfway loaded.
            imp["needs_binding"] = True
        elif imp["binding"] and imp["binding"] in collector.import_time_names:
            imp["needs_binding"] = True
            imp["binding_reason"] = "the bound name is used while the module body runs"
        else:
            imp["needs_binding"] = False
    return {
        "parse_error": None,
        "imports": collector.imports,
        "dynamic": collector.dynamic,
    }


def main():
    data = sys.stdin.buffer.read()
    paths = [p.decode("utf-8") for p in data.split(b"\0") if p]
    out = {}
    for p in paths:
        out[p] = extract(p)
    json.dump({"files": out}, sys.stdout)


if __name__ == "__main__":
    main()
