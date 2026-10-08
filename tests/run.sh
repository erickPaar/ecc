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
rm "$W1/.env"; git -C "$R" worktree remove "$W1"; git -C "$R" branch -qD w1

wt() { (cd "$R" && "$ROOT/skills/worktree/scripts/wt.sh" "$@") >"$WT/out" 2>&1; echo $?; }
check "wt: add makes the worktree"                 0     "$(wt add w2)"
check "wt: add puts it under .claude/worktrees"    yes   "$([[ -d $R/.claude/worktrees/w2 ]] && echo yes || echo no)"
check "wt: git status doesn't show it"             0     "$(git -C "$R" status --porcelain | wc -l | tr -d ' ')"
check "wt: add refuses an existing name"           1     "$(wt add w2)"
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
unset GIT_CONFIG_GLOBAL; rm -rf "$WT"

rm -rf "$HOME_STATE"
exit $fail
