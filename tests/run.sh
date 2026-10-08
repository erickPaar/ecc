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

rm -rf "$HOME_STATE"
exit $fail
