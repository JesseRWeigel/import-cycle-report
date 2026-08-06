import importlib

NAME = "alpha"


def load_beta():
    return importlib.import_module("beta")


def load_any(name):
    return importlib.import_module(name)
