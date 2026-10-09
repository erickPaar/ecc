#!/usr/bin/env bash
# Break each guard listed in tests/mutations.json, one at a time, run tests/run.sh, and print
# whether a test caught it. A claim like "every guard is tested" comes from this table, not from
# memory. A mutation marked "redundant" in mutations.json names the other control that blocks the
# same case, so no test can tell it apart. Exits 1 when any other mutation survives or no longer
# applies (the code it breaks moved).
#   tests/mutate.sh            every mutation
#   tests/mutate.sh <word>     only those whose label contains <word>
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
filter=${1:-}
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 -I - "$ROOT/tests/mutations.json" "$filter" >"$work/list" <<'PY' || exit 2
import json, sys
for i, m in enumerate(json.load(open(sys.argv[1]))):
    if sys.argv[2] in m["label"]:
        print(i, m["label"], m.get("redundant", ""), sep="\t")
PY

survived=0 total=0 redundant_n=0
while IFS=$'\t' read -r i label redundant; do
  total=$((total + 1))
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

echo "$((total - survived - redundant_n)) of $total caught, $redundant_n redundant, $survived not caught"
[[ $survived -eq 0 ]]
