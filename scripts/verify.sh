#!/usr/bin/env bash
# The exit code of this script is the result. There is no other summary worth reading.
#
# Every step either RUNS and passes, or FAILS. Nothing is skipped, including the steps that need
# something installed: a check that quietly stands down when its dependency is missing prints the
# same "ok" as one that ran and looked, and a week later the log cannot tell you which happened.
# Where a dependency is genuinely absent the failure names the command that installs it and says
# what the rest of the suite does not cover without it.
#
# Run it from a fresh clone as well as in place. Several classes of bug, a path resolved to a
# sibling directory being the usual one, only show up outside the tree they were written in:
#
#   git clone . /tmp/icr && cd /tmp/icr && npm install && bash scripts/verify.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

PASS=0
FAIL=0
FAILED_STEPS=()

# The scratch directory is RELATIVE and inside the repo, gitignored, rather than an absolute
# mktemp path. Two reasons, both learned the hard way. The output of this script gets pasted into
# the README, and an absolute /home/<user>/... path there is private and unportable. And a
# per-run temporary path printed by the tool would change the output on every run for a reason
# having nothing to do with the code, which is exactly how a fingerprint-based sabotage harness
# gets gate 2 for free.
TMP=".verify-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$ROOT/.verify-tmp"' EXIT

# Keep .pyc files out of the tree so the privacy scan and the fixture trees stay as committed.
export PYTHONDONTWRITEBYTECODE=1

hr() { printf '%s\n' "------------------------------------------------------------------------"; }

step() {
  local title="$1"
  shift
  hr
  printf '%s\n' "$title"
  hr
  if "$@"; then
    PASS=$((PASS + 1))
    printf '\n[PASS] %s\n\n' "$title"
  else
    local code=$?
    FAIL=$((FAIL + 1))
    FAILED_STEPS+=("$title")
    printf '\n[FAIL] %s (exit %d)\n\n' "$title" "$code"
  fi
}

# ---------------------------------------------------------------- 0. what is here at all

check_toolchain() {
  local bad=0
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || node_major=0
  if [ "${node_major:-0}" -lt 20 ]; then
    echo "  FAIL  node 20 or newer is required, found ${node_major:-none}."
    bad=1
  else
    echo "  ok    node $(node --version)"
  fi
  if python3 --version >/dev/null 2>&1; then
    echo "  ok    $(python3 --version)"
  else
    echo "  FAIL  python3 is required. The Python extractor and three of the checks are Python."
    bad=1
  fi
  if [ -d node_modules/typescript ]; then
    echo "  ok    typescript is installed, so the real compiler parses the TypeScript fixtures"
  else
    echo "  FAIL  node_modules/typescript is missing. Install it with:  npm install"
    echo "        Without it the TypeScript half of the tool cannot run at all: import type"
    echo "        erasure, hoisting and dynamic import handling are all unverified."
    bad=1
  fi
  if [ -d node_modules/playwright-core ]; then
    echo "  ok    playwright-core is installed, so the page gets loaded in a real browser"
  else
    echo "  FAIL  node_modules/playwright-core is missing. Install it with:"
    echo "          npm install && npx playwright install chromium"
    echo "        Without it nothing loads docs/index.html. The unit tests import the renderer"
    echo "        and never open the page, so an inline script that fails to parse would leave"
    echo "        all of them green while the page rendered as an empty shell."
    bad=1
  fi
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "  ok    inside a git repository, so the privacy scan has a file list to work from"
  else
    echo "  FAIL  not a git repository. The privacy scan reads git ls-files and would pass"
    echo "        without opening a single file."
    bad=1
  fi
  return $bad
}

# ---------------------------------------------------------------- 1. unit tests

run_unit_tests() {
  # Quiet on success, everything on failure. 177 lines of tick marks in a passing log is noise,
  # and the whole run is what you want the moment one of them is a cross.
  node --test test/*.test.mjs > "$TMP/tests.txt" 2>&1
  local status=$?
  if [ "$status" -ne 0 ]; then
    cat "$TMP/tests.txt"
    return 1
  fi
  grep -E '^(ℹ|# ) ?(tests|suites|pass|fail|cancelled|skipped|todo) ' "$TMP/tests.txt" || true

  local passed failed
  passed="$(sed -n 's/^# pass \([0-9]*\)$/\1/p;s/^ℹ pass \([0-9]*\)$/\1/p' "$TMP/tests.txt" | head -1)"
  failed="$(sed -n 's/^# fail \([0-9]*\)$/\1/p;s/^ℹ fail \([0-9]*\)$/\1/p' "$TMP/tests.txt" | head -1)"
  if [ -z "$passed" ] || [ "$passed" -lt 100 ]; then
    echo "  FAIL  only ${passed:-no} tests reported as passing. Either the glob matched nothing"
    echo "        or the runner changed its output format and this count is not real."
    return 1
  fi
  if [ "${failed:-1}" -ne 0 ]; then
    echo "  FAIL  $failed test(s) failed"
    return 1
  fi
  echo "  ok    $passed tests passed, 0 failed"
  echo "$passed" > "$TMP/test-count.txt"
  return 0
}

# ---------------------------------------------------------------- 2. fixtures against the runtime

run_fixture_truth() { node scripts/fixture_truth.mjs; }

# ---------------------------------------------------------------- 3. the CLI, end to end

run_cli() {
  local bad=0

  # A tree with no cycles must exit 0 even at the strictest threshold. This is the negative
  # control at the command line: a tool that flags everything cannot pass it.
  if node bin/cycles.mjs fixtures/trees/py-clean --lang py --label clean \
      --out "$TMP/clean.html" --fail-on types --quiet; then
    echo "  ok    a clean tree exits 0 with --fail-on types, the strictest setting"
  else
    echo "  FAIL  the clean fixture tree was flagged. A detector that fires on a DAG is noise."
    bad=1
  fi

  # And a tree that really raises must exit 1.
  node bin/cycles.mjs fixtures/trees/py-triangle --lang py --label triangle \
    --out "$TMP/tri.html" --fail-on breaks --quiet
  if [ $? -eq 1 ]; then
    echo "  ok    the three module cycle that really raises exits 1 with --fail-on breaks"
  else
    echo "  FAIL  a tree that raises ImportError at runtime did not fail the gate"
    bad=1
  fi

  # A cycle that runs today must not fail a gate set at breaks, or the gate is unusable.
  if node bin/cycles.mjs fixtures/trees/py-fragile --lang py --label fragile \
      --out "$TMP/frag.html" --fail-on breaks --quiet; then
    echo "  ok    an import time cycle that loads cleanly does not trip --fail-on breaks"
  else
    echo "  FAIL  a cycle that imports without error was ranked as breaking"
    bad=1
  fi

  # The output is one file, openable with no server and no network.
  local size
  size=$(wc -c < "$TMP/tri.html")
  if [ "$size" -lt 8000 ]; then
    echo "  FAIL  the report is only $size bytes, which is not a whole page"
    bad=1
  else
    echo "  ok    the report is one self contained file of $size bytes"
  fi
  if grep -qiE '<(script|link|img)[^>]+(src|href)=["'"'"']?(https?:)?//' "$TMP/tri.html"; then
    echo "  FAIL  the report pulls something off the network"
    bad=1
  else
    echo "  ok    the report references nothing off the machine, so it survives being emailed"
  fi
  return $bad
}

# ---------------------------------------------------------------- 4. the page is rebuilt, not stale

run_docs() {
  node scripts/build_docs.mjs || return 1
  if git diff --quiet -- docs/index.html; then
    echo "  ok    docs/index.html regenerated byte for byte from the committed demo tree"
  else
    echo "  FAIL  docs/index.html is not what the current code produces. The published page has"
    echo "        drifted from the analysis behind it. Commit the rebuilt file."
    git --no-pager diff --stat -- docs/index.html
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------- 5. a real browser

run_browser() { node scripts/browser_check.mjs; }

# ---------------------------------------------------------------- 6. independent recomputation

run_independent() {
  node bin/cycles.mjs fixtures/demo --label demo --include-graph \
    --json "$TMP/demo.json" --out "$TMP/demo.html" --fail-on never --quiet || return 1
  python3 scripts/check_independent.py --json "$TMP/demo.json" --root fixtures/demo
}

# ---------------------------------------------------------------- 7. privacy

run_privacy() { python3 scripts/privacy_scan.py; }

# ---------------------------------------------------------------- 8. real code, not just fixtures

run_real_code() {
  local bad=0
  # Its own source is the one real tree guaranteed to be present in a fresh clone. --label keeps
  # the machine's directory layout out of the output.
  node bin/cycles.mjs src --lang ts --label "this tool's own src" \
    --out "$TMP/self.html" --json "$TMP/self.json" --fail-on never || bad=1
  local mods
  mods=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['totals']['modules'])" "$TMP/self.json")
  if [ "${mods:-0}" -lt 5 ]; then
    echo "  FAIL  only ${mods:-0} modules found in src/, so nothing real was analysed"
    bad=1
  else
    echo "  ok    analysed its own $mods module src/ tree"
  fi
  if grep -q "$HOME" "$TMP/self.html"; then
    echo "  FAIL  a path from this machine reached the report for a tree given by absolute path"
    bad=1
  else
    echo "  ok    no path from this machine reached the report"
  fi
  return $bad
}

# ---------------------------------------------------------------- 9. sabotage

run_sabotage() { python3 scripts/sabotage.py; }

# ---------------------------------------------------------------- 10. the README is not a stub

run_readme() {
  local bad=0
  if [ ! -f README.md ]; then
    echo "  FAIL  there is no README.md"
    return 1
  fi
  # The markers are assembled from fragments, and matched case sensitively, for the same reason
  # the privacy scan assembles its patterns: the Status section of this README holds the pasted
  # output of this very script, so a literal marker written here would be found in the README by
  # its own check. Node's test summary also prints a lowercase "todo 0" line into that paste.
  local markers=("TO""DO" "FIX""ME" "XX""X" "replace with a real description" "NOT YET VERIFIED")
  local found=0
  for m in "${markers[@]}"; do
    if grep -qF -- "$m" README.md; then
      echo "  FAIL  README.md still contains a stub marker at:"
      grep -nF -- "$m" README.md | head -3
      found=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "  ok    README.md has no stub marker left in it"
  else
    bad=1
  fi
  if grep -q '^## Status' README.md; then
    echo "  ok    README.md has a Status section"
  else
    echo "  FAIL  README.md has no ## Status section, so nothing records that this ever ran"
    bad=1
  fi
  if grep -q "$SUCCESS_LINE" README.md; then
    echo "  ok    the Status section carries this script's own success line"
  else
    echo "  FAIL  README.md does not contain \"$SUCCESS_LINE\"."
    echo "        Paste the real output of this script into the Status section."
    bad=1
  fi
  # The test count in the README is a claim like any other and goes stale the moment somebody
  # adds a test.
  if [ -f "$TMP/test-count.txt" ]; then
    local n
    n="$(cat "$TMP/test-count.txt")"
    if grep -q "$n unit tests" README.md; then
      echo "  ok    the README's test count still says $n, which is what just ran"
    else
      echo "  FAIL  the README does not say \"$n unit tests\". The suite has $n tests now."
      bad=1
    fi
  else
    echo "  FAIL  the unit test step did not produce a count, so the README claim was not checked"
    bad=1
  fi
  return $bad
}

# ---------------------------------------------------------------- run them

TOTAL_STEPS=11
SUCCESS_LINE="VERIFY PASSED: $TOTAL_STEPS of $TOTAL_STEPS steps"

# A verify run must not modify the repository it is verifying. During the README repair on
# 2026-08-07 this script's exit code alternated between 0 and 1 across identical invocations, and
# the README's checksum moved with no edit between runs. The cause was never reproduced after the
# tree settled, so instead of asserting it is gone, this records the tracked-file digest before
# the run and compares it after. A mutation is now a named failure rather than a puzzle.
TRACKED_BEFORE="$(git ls-files -z 2>/dev/null | xargs -0 -r md5sum 2>/dev/null | md5sum)"

printf 'import-cycle-report verify\n\n'

step "1/11 toolchain and repository preconditions" check_toolchain
step "2/11 unit tests" run_unit_tests
step "3/11 fixture trees against the real Python and Node runtimes" run_fixture_truth
step "4/11 the command line tool end to end" run_cli
step "5/11 docs/index.html rebuilt from the demo tree and diffed" run_docs
step "6/11 the published page loaded in a real browser" run_browser
step "7/11 independent recomputation by a different algorithm" run_independent
step "8/11 privacy scan with a positive control" run_privacy
step "9/11 the tool run against real source" run_real_code
step "10/11 sabotage under the three gate rule" run_sabotage
# Last, because it checks for this script's own success line and the count the tests just reported.
step "11/11 the README is finished and its numbers still match" run_readme

hr
# The run must not have changed the repository it was checking. Step 5 rebuilds docs and step 10
# copies the tree, so a stray write into the working copy is plausible and would make the second
# invocation pass for reasons the first one created.
TRACKED_AFTER="$(git ls-files -z 2>/dev/null | xargs -0 -r md5sum 2>/dev/null | md5sum)"
if [ "$TRACKED_BEFORE" = "$TRACKED_AFTER" ]; then
  printf '  ok    the run changed no tracked file, so its result is a fact about the code\n'
else
  printf '  FAIL  this run MODIFIED a tracked file. A verify that edits the tree it checks can\n'
  printf '        pass on a later run for reasons an earlier run created.\n'
  git status --short | head -5
  FAIL=$((FAIL + 1))
  FAILED_STEPS+=("the run modified a tracked file")
fi

hr
if [ "$FAIL" -eq 0 ] && [ "$PASS" -eq "$TOTAL_STEPS" ]; then
  printf '%s\n' "$SUCCESS_LINE"
  exit 0
fi
printf 'VERIFY FAILED: %d of %d steps passed, %d failed\n' "$PASS" "$TOTAL_STEPS" "$FAIL"
for s in "${FAILED_STEPS[@]:-}"; do
  [ -n "$s" ] && printf '  failed: %s\n' "$s"
done
exit 1
