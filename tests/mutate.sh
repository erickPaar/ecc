#!/usr/bin/env bash
# Break each guard listed in tests/mutations.json, one at a time, run tests/run.sh, and print
# whether a test caught it. A claim like "every guard is tested" comes from this table, not from
# memory.
#   - "redundant": names the other control that blocks the same case, so no test can tell it apart.
#   - "needs_bash": the major.minor bash the case shows up on; skipped, and said so, on an older bash.
# The mutations run in a throwaway copy of the tree: an interrupted run never leaves a guard broken
# in your checkout. Exits 1 when any other mutation survives or no longer applies (the code moved).
#   tests/mutate.sh            every mutation
#   tests/mutate.sh <word>     only those whose label contains <word>
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
filter=${1:-}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'echo "interrupted"; exit 130' INT TERM HUP
mkdir "$work/tree"
tar -C "$ROOT" --exclude=./.git --exclude=./.claude/worktrees -cf - . | tar -C "$work/tree" -xf - \
  || { echo "could not copy the tree" >&2; exit 2; }
cd "$work/tree" || exit 2
# A copy that already fails would make every mutation look caught.
tests/run.sh >"$work/baseline" 2>&1 || { echo "tests/run.sh fails before any mutation:" >&2; grep '^FAIL' "$work/baseline" >&2; exit 2; }

python3 -I - tests/mutations.json "$filter" "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" >"$work/list" <<'PY' || exit 2
import json, sys
have = tuple(int(x) for x in sys.argv[3].split("."))
for i, m in enumerate(json.load(open(sys.argv[1]))):
    if sys.argv[2] not in m["label"]:
        continue
    need = m.get("needs_bash", "")
    skip = need and tuple(int(x) for x in need.split(".")) > have
    # \x1f, not a tab: read collapses empty fields between whitespace delimiters.
    print(i, m["label"], m.get("redundant", ""), ("needs bash " + need) if skip else "", sep="\x1f")
PY

survived=0 total=0 redundant_n=0 skipped=0
while IFS=$'\x1f' read -r i label redundant skip; do
  total=$((total + 1))
  if [[ -n $skip ]]; then
    printf '%-58s skipped (%s)\n' "$label" "$skip"; skipped=$((skipped + 1)); continue
  fi
  file=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["file"])' tests/mutations.json "$i")
  cp "$file" "$work/backup"
  if ! python3 -I - tests/mutations.json "$i" <<'PY'; then
import json, sys
m = json.load(open(sys.argv[1]))[int(sys.argv[2])]
s = open(m["file"]).read()
if s.count(m["find"]) != 1:
    sys.exit(1)
open(m["file"], "w").write(s.replace(m["find"], m["replace"], 1))
PY
    printf '%-58s %s\n' "$label" "NO LONGER APPLIES"; survived=$((survived + 1)); continue
  fi
  failed=$(tests/run.sh 2>&1 | grep -c '^FAIL')
  cp "$work/backup" "$file"
  if [[ $failed -gt 0 ]]; then
    printf '%-58s caught (%s)\n' "$label" "$failed"
  elif [[ -n $redundant ]]; then
    printf '%-58s redundant: %s\n' "$label" "$redundant"; redundant_n=$((redundant_n + 1))
  else
    printf '%-58s SURVIVED\n' "$label"; survived=$((survived + 1))
  fi
done <"$work/list"

echo "$((total - survived - redundant_n - skipped)) of $total caught, $redundant_n redundant, $skipped skipped, $survived not caught"
[[ $survived -eq 0 ]]
