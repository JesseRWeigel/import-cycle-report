from util import dump

VERSION = 1


def render(x):
    return dump({"v": VERSION, "x": x})
