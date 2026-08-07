# A three module cycle: alpha -> gamma -> beta -> alpha.
#
# Two module cycles are the easy case, because there is only one way round the loop. Three is
# where a back edge check starts naming a different pair on every run, depending on which file
# the walk happened to open first. The component is the same set of three either way.
from gamma import GAMMA

ALPHA = f"alpha via {GAMMA}"
