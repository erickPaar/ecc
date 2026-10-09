#!/usr/bin/env bash
# Feed the hooks the JSON Claude Code sends and check their decisions.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export CLAUDE_PLUGIN_ROOT=$ROOT HOME_STATE=$(mktemp -d)
export GATEGUARD_STATE_DIR=$HOME_STATE GATEGUARD_BASH_ROUTINE_DISABLED=1
fail=0

bash_input() { jq -cn --arg c "$1" --arg s "${2:-test-session}" \
  '{session_id: $s, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {command: $c}}'; }
decision() { # no output means the hook allowed the call
  [[ -n "${1:-}" ]] || { echo allow; return; }
  jq -r '.hookSpecificOutput.permissionDecision // "allow"' <<<"$1" 2>/dev/null || echo allow
}

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1: expected $2, got $3"; fail=1; fi
}

guard() { decision "$(bash_input "$1" | env AWS_PROFILE="${2:-}" ECC_SAFE_PROFILES="${3:-}" "$ROOT/hooks/prod-guard.sh")"; }
check "tofu apply asks"                       ask   "$(guard 'tofu apply')"
check "tofu with flags before apply asks"     ask   "$(guard 'tofu -chdir=modules/app apply -auto-approve')"
check "terragrunt run-all destroy asks"       ask   "$(guard 'cd live && terragrunt run-all destroy')"
check "tofu state rm asks"                    ask   "$(guard 'tofu state rm aws_s3_bucket.x')"
check "tofu plan passes"                      allow "$(guard 'tofu plan -out=tfplan')"
check "tofu init passes"                      allow "$(guard 'tofu init')"
check "aws delete-stack asks"                 ask   "$(guard 'aws cloudformation delete-stack --stack-name x --profile production')"
check "aws s3 rm asks"                        ask   "$(guard 'aws s3 rm s3://bucket/key')"
check "aws read-only passes"                  allow "$(guard 'aws ssm get-parameter --name /x')"
check "safe profile from env passes"          allow "$(guard 'tofu apply' dev dev)"
check "safe profile inline passes"            allow "$(guard 'AWS_PROFILE=dev tofu apply' '' dev)"
check "--profile overrides safe env"          ask   "$(guard 'aws s3 rm s3://b/k --profile production' dev dev)"
reason=$(bash_input 'aws s3 rb s3://b --profile production' | "$ROOT/hooks/prod-guard.sh" | jq -r .hookSpecificOutput.permissionDecisionReason)
check "reason names the profile"              yes   "$([[ $reason == *"'production'"* ]] && echo yes || echo no)"

gate() { decision "$(bash_input "$1" "$2" | "$ROOT/bin/node-run" "$ROOT/bin/run-hook.js" "$ROOT/scripts/hooks/gateguard-fact-force.js")"; }
check "gateguard: rm -rf denied first"        deny  "$(gate 'rm -rf build' s1)"
check "gateguard: rm -rf allowed on retry"    allow "$(gate 'rm -rf build' s1)"
check "gateguard: git push --force denied"    deny  "$(gate 'git push --force origin main' s1)"
check "gateguard: routine command passes"     allow "$(gate 'ls -la' s2)"

out=$(jq -cn '{session_id: "c1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {file_path: "/tmp/x"}}' \
  | "$ROOT/bin/node-run" "$ROOT/scripts/hooks/suggest-compact.js" 2>&1; echo "exit=$?")
check "suggest-compact runs cleanly"          yes   "$([[ $out == *exit=0 ]] && echo yes || echo no)"

edit_input() { jq -cn --arg f "$1" --arg o "$2" --arg n "$3" \
  '{hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {file_path: $f, old_string: $o, new_string: $n}}'; }
supp() { decision "$(edit_input "$1" "$2" "$3" | python3 -I "$ROOT/hooks/suppression-guard.py")"; }
check "suppress: new noqa asks"               ask   "$(supp app.py 'x = f()' 'x = f()  # noqa: E501')"
check "suppress: new type: ignore asks"       ask   "$(supp app.py 'y = g()' 'y = g()  # type: ignore[arg-type]')"
check "suppress: new go nolint asks"          ask   "$(supp main.go 'err := run()' 'err := run() //nolint:errcheck')"
check "suppress: new dart ignore asks"        ask   "$(supp w.dart 'final a = 1;' '// ignore: unused_local_variable
final a = 1;')"
check "suppress: moving a noqa passes"        allow "$(supp app.py 'a = 1  # noqa' 'b = 2  # noqa')"
check "suppress: removing a noqa passes"      allow "$(supp app.py 'a = 1  # noqa' 'a = 1')"
check "suppress: plain code edit passes"      allow "$(supp app.py 'return a' 'return a + b')"
check "config: new ruff ignore asks"          ask   "$(supp pyproject.toml '[tool.ruff.lint]' '[tool.ruff.lint]
ignore = ["E501"]')"
check "config: dropping select asks"          ask   "$(supp pyproject.toml 'extend-select = ["B", "UP"]' '')"
check "config: golangci disable asks"         ask   "$(supp .golangci.yml 'linters:' 'linters:
  disable:
    - errcheck')"
check "config: dependency bump passes"        allow "$(supp pyproject.toml '"httpx>=0.27"' '"httpx>=0.28"')"
check "config: requires-python bump passes"   allow "$(supp pyproject.toml 'requires-python = ">=3.12"' 'requires-python = ">=3.13"')"
check "config: 'ignore' outside configs passes" allow "$(supp notes.md 'a' 'ignore this')"
T=$(mktemp); printf 'x = 1  # noqa\n' > "$T"
w=$(jq -cn --arg f "$T" '{tool_name: "Write", tool_input: {file_path: $f, content: "x = 1  # noqa\ny = 2  # noqa\n"}}' | python3 -I "$ROOT/hooks/suppression-guard.py")
check "write: adding a second noqa asks"      ask   "$(decision "$w")"
rm -f "$T"

# A throwaway repository with a bare remote, for the worktree guard and the worktree skill.
WT=$(mktemp -d); export GIT_CONFIG_GLOBAL=$WT/gitconfig
git config --global user.email t@example.com; git config --global user.name t; git config --global init.defaultBranch main
git init -q --bare "$WT/origin.git"; git clone -q "$WT/origin.git" "$WT/repo" 2>/dev/null
R=$WT/repo; printf '.env\n__pycache__/\n' > "$R/.gitignore"; echo a > "$R/a.txt"
git -C "$R" add . && git -C "$R" commit -qm init && git -C "$R" push -q origin main
git -C "$R" remote set-head origin -a >/dev/null

wg_input() { jq -cn --arg c "$1" --arg d "$2" '{hook_event_name: "PreToolUse", tool_name: "Bash", cwd: $d, tool_input: {command: $c}}'; }
wg() { decision "$(wg_input "$1" "${2:-$R}" | "$ROOT/hooks/worktree-guard.sh")"; }
git -C "$R" worktree add -q -b w1 "$R/.claude/worktrees/w1"; W1=$R/.claude/worktrees/w1
check "wguard: remove of a clean worktree passes"  allow "$(wg 'git worktree remove .claude/worktrees/w1')"
mkdir -p "$W1/__pycache__"; touch "$W1/__pycache__/x.pyc"
check "wguard: caches alone don't ask"             allow "$(wg 'git worktree remove .claude/worktrees/w1')"
echo S=1 > "$W1/.env"
check "wguard: remove with an ignored .env asks"   ask   "$(wg "git worktree remove --force $W1")"
rm "$W1/.env"; echo b >> "$W1/a.txt"
check "wguard: remove with changes asks"           ask   "$(wg 'git worktree remove .claude/worktrees/w1')"
check "wguard: reset --hard with changes asks"     ask   "$(wg "cd $W1 && git reset --hard origin/main")"
check "wguard: checkout -- . with changes asks"    ask   "$(wg 'git checkout -- .' "$W1")"
check "wguard: restore with changes asks"          ask   "$(wg "git -C $W1 restore a.txt")"
check "wguard: restore --staged passes"            allow "$(wg "git -C $W1 restore --staged a.txt")"
git -C "$W1" checkout -q -- a.txt
check "wguard: reset --hard when clean passes"     allow "$(wg 'git reset --hard origin/main' "$W1")"
git -C "$W1" commit -q --allow-empty -m local
check "wguard: reset --hard over a local commit asks" ask "$(wg 'git reset --hard origin/main' "$W1")"
git -C "$W1" reset -q --hard origin/main; echo S=1 > "$W1/.env"
check "wguard: clean -fdx with a .env asks"        ask   "$(wg 'git clean -fdx' "$W1")"
check "wguard: clean -fd ignores ignored files"    allow "$(wg 'git clean -fd' "$W1")"
check "wguard: clean -n passes"                    allow "$(wg 'git clean -ndx' "$W1")"
check "wguard: other git commands pass"            allow "$(wg 'git status && git log -1' "$W1")"
reason=$(wg_input 'git worktree remove .claude/worktrees/w1' "$R" | "$ROOT/hooks/worktree-guard.sh" | jq -r .hookSpecificOutput.permissionDecisionReason)
check "wguard: reason names the file"              yes   "$([[ $reason == *.env* ]] && echo yes || echo no)"
rm "$W1/.env"; git -C "$W1" commit -q --allow-empty -m local-only
check "wguard: remove with a commit on no remote asks" ask "$(wg 'git worktree remove .claude/worktrees/w1')"
git -C "$W1" reset -q --hard origin/main; echo b >> "$W1/a.txt"
check "wguard: reset without --hard passes"        allow "$(wg 'git reset HEAD a.txt' "$W1")"
check "wguard: (cd w && reset --hard) asks"        ask   "$(wg "(cd $W1 && git reset --hard)")"
check "wguard: pushd then reset --hard asks"       ask   "$(wg "pushd $W1 && git reset --hard")"
check "wguard: /usr/bin/git reset --hard asks"     ask   "$(wg "/usr/bin/git -C $W1 reset --hard")"
check "wguard: checkout HEAD -- file asks"         ask   "$(wg 'git checkout HEAD -- a.txt' "$W1")"
check "wguard: checkout -f asks"                   ask   "$(wg 'git checkout -f main' "$W1")"
check "wguard: switch --discard-changes asks"      ask   "$(wg 'git switch --discard-changes main' "$W1")"
check "wguard: restore -W --staged asks"           ask   "$(wg 'git restore --worktree --staged .' "$W1")"
check "wguard: restore -SW asks"                   ask   "$(wg 'git restore -SW .' "$W1")"
check "wguard: checkout a branch passes"           allow "$(wg 'git checkout -b other' "$W1")"
git -C "$W1" checkout -q -- a.txt; mkdir -p "$W1/new"; touch "$W1/new/f"
check "wguard: clean --force -d asks"              ask   "$(wg 'git clean -d --force' "$W1")"
check "wguard: clean --dry-run passes"             allow "$(wg 'git clean -fd --dry-run' "$W1")"
echo b >> "$W1/a.txt"
check "wguard: a # comment doesn't hide the next line" ask "$(wg "$(printf 'git fetch  # update first\ngit checkout -- .')" "$W1")"
check "wguard: a # inside a word doesn't hide it"  ask   "$(wg 'git log --format=%h#%s -1; git checkout -- .' "$W1")"
check "wguard: git inside if/then asks"            ask   "$(wg 'if git diff --quiet; then :; else git checkout -- .; fi' "$W1")"
check "wguard: git inside a for loop asks"         ask   "$(wg 'for d in .; do git -C "$d" checkout -- .; done' "$W1")"
check "wguard: sudo -u x git asks"                 ask   "$(wg 'sudo -u x git reset --hard' "$W1")"
check "wguard: checkout <file> without -- asks"    ask   "$(wg 'git checkout a.txt' "$W1")"
check "wguard: checkout HEAD <file> asks"          ask   "$(wg 'git checkout HEAD a.txt' "$W1")"
check "wguard: a redirect stuck to --hard asks"    ask   "$(wg 'git reset --hard>/dev/null' "$W1")"
check "wguard: cd to a missing folder stays put"   ask   "$(wg 'cd nowhere 2>/dev/null; git checkout -- .' "$W1")"
git -C "$W1" checkout -q -- a.txt
rm -r "$W1/new"; git -C "$W1" commit -q --allow-empty -m ahead
check "wguard: reset --hard to HEAD keeps commits" allow "$(wg 'git reset --hard' "$W1")"
git -C "$W1" reset -q --hard origin/main
git -C "$R" worktree add -q -b w3 "$R/.claude/worktrees/my wt"; echo S=1 > "$R/.claude/worktrees/my wt/.env"
check "wguard: quoted path with a space asks"      ask   "$(wg 'git worktree remove ".claude/worktrees/my wt"')"
check "wguard: worktree given by name asks"        ask   "$(wg 'git worktree remove "my wt"')"
check "wguard: commit message mentioning it passes" allow "$(wg 'git commit --allow-empty -m "no reset --hard here"')"
rm "$R/.claude/worktrees/my wt/.env"; git -C "$R" worktree remove "$R/.claude/worktrees/my wt"; git -C "$R" branch -qD w3
git -C "$R" worktree remove "$W1"; git -C "$R" branch -qD w1

wt() { (cd "$R" && "$ROOT/skills/worktree/scripts/wt.sh" "$@") >"$WT/out" 2>&1; echo $?; }
check "wt: add makes the worktree"                 0     "$(wt add w2)"
check "wt: add puts it under .claude/worktrees"    yes   "$([[ -d $R/.claude/worktrees/w2 ]] && echo yes || echo no)"
check "wt: git status doesn't show it"             0     "$(git -C "$R" status --porcelain | wc -l | tr -d ' ')"
check "wt: add refuses an existing name"           1     "$(wt add w2)"
git -C "$R" branch taken
check "wt: add refuses an existing branch"         1     "$(wt add other taken)"
git -C "$R" branch -qD taken
W2=$R/.claude/worktrees/w2; echo c >> "$W2/a.txt"
check "wt: rm refuses changes"                     1     "$(wt rm w2)"
git -C "$W2" checkout -q -- a.txt; git -C "$W2" commit -q --allow-empty -m local
check "wt: rm refuses a commit on no remote"       1     "$(wt rm w2)"
git -C "$W2" reset -q --hard origin/main; echo S=1 > "$W2/.env"; mkdir -p "$W2/__pycache__"; touch "$W2/__pycache__/y.pyc"
check "wt: rm removes a clean worktree"            0     "$(wt rm w2)"
kept=$(find "$R/.claude/worktrees/.removed" -name .env | head -1)
check "wt: rm keeps the ignored .env"              yes   "$([[ -n $kept && $(cat "$kept") == S=1 ]] && echo yes || echo no)"
check "wt: rm skips caches"                        0     "$(find "$R/.claude/worktrees/.removed" -name '*.pyc' | wc -l | tr -d ' ')"
check "wt: rm deletes the local branch"            no    "$(git -C "$R" show-ref -q --verify refs/heads/w2 && echo yes || echo no)"
check "wt: rm refuses the main checkout"           1     "$(wt rm "$R")"
check "wt: list runs"                              0     "$(wt list)"
wt add w4 >/dev/null; wt add w5 >/dev/null; rm -rf "$R/.claude/worktrees/w4"
check "wt: list goes on past a deleted worktree"   yes   "$(wt list >/dev/null; grep -q w5 "$WT/out" && echo yes || echo no)"
check "wt: list says the folder is gone"           yes   "$(grep -q 'folder gone' "$WT/out" && echo yes || echo no)"
git -C "$R" worktree prune; git -C "$R" branch -qD w4
W5=$R/.claude/worktrees/w5; echo x > "$W5/my file.log"; echo '*.log' >> "$R/.git/info/exclude"
check "wt: rm keeps an ignored file with a space"  0     "$(wt rm w5)"
check "wt: the spaced file is in .removed"         yes   "$([[ -n $(find "$R/.claude/worktrees/.removed" -name 'my file.log') ]] && echo yes || echo no)"
W6=$R/.claude/worktrees/w6; wt add w6 >/dev/null; ln -s /nonexistent "$W6/.env"
check "wt: rm keeps a dangling ignored symlink"    0     "$(wt rm w6)"
git -C "$R" push -q origin main:feat/x
check "wt: add tracks a branch only on origin"     yes   "$(wt add rev feat/x >/dev/null; [[ $(git -C "$R/.claude/worktrees/rev" rev-parse --abbrev-ref '@{u}' 2>/dev/null) == origin/feat/x ]] && echo yes || echo no)"
check "wt: rm by absolute path from outside"       0     "$(cd / && "$ROOT/skills/worktree/scripts/wt.sh" rm "$R/.claude/worktrees/rev" >/dev/null 2>&1; echo $?)"
NO=$WT/noorigin; git init -q "$NO"; git -C "$NO" commit -q --allow-empty -m i
check "wt: list in a repo without origin"          0     "$( (cd "$NO" && "$ROOT/skills/worktree/scripts/wt.sh" list) >/dev/null 2>&1; echo $?)"
check "wt: add without origin uses HEAD"           0     "$( (cd "$NO" && "$ROOT/skills/worktree/scripts/wt.sh" add n1) >/dev/null 2>&1; echo $?)"
# The worklog beside each worktree.
wt add w7 >/dev/null; L7=$R/.claude/worktrees/w7.md
check "worklog: add writes it beside the worktree" yes   "$([[ -f $L7 ]] && grep -q '^- branch: w7' "$L7" && echo yes || echo no)"
check "worklog: it is never committed"             0     "$(git -C "$R/.claude/worktrees/w7" status --porcelain | wc -l | tr -d ' ')"
sed -i 's/^- status: started/- status: writing the parser/; s/^- next:$/- next: the tests/' "$L7"; printf -- '- status: an old line in the log\n' >> "$L7"
check "worklog: list shows status and next"        yes   "$(wt list >/dev/null; grep -q 'status: writing the parser' "$WT/out" && grep -q 'next:   the tests' "$WT/out" && echo yes || echo no)"
check "worklog: list ignores the log section"     no    "$(grep -q 'an old line in the log' "$WT/out" && echo yes || echo no)"
check "worklog: rm keeps it in .removed"           yes   "$(wt rm w7 >/dev/null; [[ ! -e $L7 && -n $(find "$R/.claude/worktrees/.removed" -name worklog.md -path '*w7-*') ]] && echo yes || echo no)"

# A squash merge gives the branch's commits new ids; rm sees the content is on main.
wt add w8 >/dev/null; W8=$R/.claude/worktrees/w8
echo squashed > "$W8/s.txt"; git -C "$W8" add s.txt; git -C "$W8" commit -qm one; echo more >> "$W8/s.txt"; git -C "$W8" commit -qam two
check "wt: rm refuses commits whose content isn't on main" 1 "$(wt rm w8)"
git -C "$R" checkout -q main; git -C "$R" merge -q --squash w8 && git -C "$R" commit -qm "squash w8" && git -C "$R" push -q origin main
check "wt: rm accepts a squash-merged branch"      0     "$(wt rm w8)"

# wt.sh: special characters in the worklog, a symlinked script, renames.
check "worklog: an owner with | & and \\ is written as is" yes "$(WT_OWNER='A | B & C\new' wt add w13 >/dev/null; grep -qF -- '- owner: A | B & C\new' "$R/.claude/worktrees/w13.md" && echo yes || echo no)"
ln -s "$ROOT/skills/worktree/scripts/wt.sh" "$WT/wtlink"
check "worklog: written through a symlinked script" yes "$( (cd "$R" && "$WT/wtlink" add w14) >/dev/null 2>&1; [[ -s $R/.claude/worktrees/w14.md ]] && echo yes || echo no)"
W13=$R/.claude/worktrees/w13; git -C "$W13" mv a.txt moved.txt; git -C "$W13" commit -qm mv
git -C "$R" checkout -q main; cp "$R/a.txt" "$R/moved.txt"; git -C "$R" add moved.txt; git -C "$R" commit -qm "moved.txt, a.txt kept"; git -C "$R" push -q origin main
check "wt: rm refuses a rename whose old file is still on main" 1 "$(wt rm w13)"

# Guards the mutation table asked tests for.
check "wt: add refuses a name with a slash"        1     "$(wt add x/foo)"
wt add g1 >/dev/null; G1=$R/.claude/worktrees/g1; echo old > "$R/.claude/worktrees/g2.md"
check "worklog: an old worklog is moved, not reused" yes "$(wt add g2 >/dev/null; ! grep -q old "$R/.claude/worktrees/g2.md" && ls "$R/.claude/worktrees/.removed/" | grep -q '^g2-stale-' && echo yes || echo no)"
(cd "$G1" && exec sleep 30) & SLEEPER=$!; sleep 0.3
check "wt: rm refuses a worktree a process runs in" 1    "$(wt rm g1)"
kill $SLEEPER 2>/dev/null; wait $SLEEPER 2>/dev/null
sed -i 's/^- status: started/- status: seen through a link/' "$R/.claude/worktrees/g1.md"; ln -s "$R" "$WT/rlink"
linked=$( (cd / && WT_ROOTS="$WT/rlink" "$ROOT/skills/worktree/scripts/wt.sh" list) 2>/dev/null)
check "worklog: list reads it through a symlinked repo path" yes "$(grep -q 'seen through a link' <<<"$linked" && echo yes || echo no)"
git -C "$R" worktree add -q -b g3 "$WT/g3"; printf -- '- status: not this worktree\n' > "$WT/g3.md"
check "worklog: list skips a worktree outside .claude/worktrees" no "$(wt list >/dev/null; grep -q 'not this worktree' "$WT/out" && echo yes || echo no)"
git -C "$R" worktree remove "$WT/g3"; git -C "$R" branch -qD g3
# A file named like a glob is compared literally.
wt add g4 >/dev/null; G4=$R/.claude/worktrees/g4
echo star > "$G4/x*"; git -C "$G4" add -- 'x*'; git -C "$G4" commit -qm star
git -C "$R" checkout -q main; echo star > "$R/x*"; echo other > "$R/xa"; git -C "$R" add -- 'x*' xa; git -C "$R" commit -qm "x* and xa"; git -C "$R" push -q origin main
check "merged: a file named x* is compared literally" 0  "$(wt rm g4)"
# GitHub's answer: a stub gh prints the pull requests in GH_PRS through the query wt.sh passes.
mkdir -p "$WT/bin"; cat > "$WT/bin/gh" <<'GH'
#!/usr/bin/env bash
q=""; while [[ $# -gt 0 ]]; do [[ $1 == -q ]] && { q=$2; shift; }; shift; done
jq -r "$q" <<<"${GH_PRS:-[]}"
GH
chmod +x "$WT/bin/gh"; git -C "$R" remote set-url origin "https://github.com/someone/repo.git"
gwt() { (cd "$R" && PATH="$WT/bin:$PATH" GH_PRS=$1 "$ROOT/skills/worktree/scripts/wt.sh" rm g5) >/dev/null 2>&1; echo $?; }
git -C "$R" remote set-url origin "$WT/origin.git"; wt add g5 >/dev/null; G5=$R/.claude/worktrees/g5
echo five > "$G5/five.txt"; git -C "$G5" add five.txt; git -C "$G5" commit -qm five; H5=$(git -C "$G5" rev-parse HEAD)
git -C "$R" remote set-url origin "https://github.com/someone/repo.git"
check "merged: gh at another head is not enough"   1     "$(gwt "[{\"headRefOid\": \"0000\", \"baseRefName\": \"main\"}]")"
check "merged: gh into another base is not enough" 1     "$(gwt "[{\"headRefOid\": \"$H5\", \"baseRefName\": \"develop\"}]")"
check "merged: gh at this head into main is"       0     "$(gwt "[{\"headRefOid\": \"$H5\", \"baseRefName\": \"main\"}]")"
git -C "$R" remote set-url origin "$WT/origin.git"

unset GIT_CONFIG_GLOBAL; rm -rf "$WT"

rm -rf "$HOME_STATE"
exit $fail
