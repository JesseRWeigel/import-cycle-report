import importlib

BUILTIN = "plugins.echo"


def load_builtin():
    return importlib.import_module(BUILTIN)


def load(name):
    # The target is only known at run time, so no static tool can draw this edge.
    return importlib.import_module(f"plugins.{name}")
