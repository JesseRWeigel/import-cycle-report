"""Leaf module. Imports nothing from this tree."""
import json


def dump(x):
    return json.dumps(x)
