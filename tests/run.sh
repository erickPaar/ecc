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

rm -rf "$HOME_STATE"
exit $fail
