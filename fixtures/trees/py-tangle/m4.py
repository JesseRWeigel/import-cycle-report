# One tangled component, deliberately too big for an exhaustive feedback arc search.
#
# Eight modules, each importing three others, gives 24 arcs in a single strongly connected
# component. The exact search in src/fas.mjs stops at 22 arcs, so this tree is what exercises the
# Eades, Lin and Smyth heuristic and the "proven: false" path that goes with it. Every import here
# is a plain `import`, which binds a module object rather than reading a name out of one, so the
# whole thing loads without complaint. It is a maintenance problem and not a crash.
import m5
import m7
import m1

NAME = "m4"


def neighbours():
    return [m5.NAME, m7.NAME, m1.NAME]
