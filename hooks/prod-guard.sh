#!/usr/bin/env bash
# PreToolUse(Bash): make the user confirm infrastructure changes and AWS deletions,
# even in auto mode. Profiles listed in ECC_SAFE_PROFILES (comma-separated,
# e.g. "dev") pass without asking; with the list empty, every match asks.

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)
[[ -n "$cmd" ]] || exit 0

iac='(^|[^[:alnum:]_-])(tofu|terraform|terragrunt)([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy|import|taint|force-unlock|state[[:space:]]+(rm|mv|push|replace-provider)|run-all[[:space:]]+(apply|destroy))'
aws='(^|[^[:alnum:]_-])aws[[:space:]](.*[[:space:]])?((delete|terminate|remove|deregister|purge|revoke|disable)-[a-z-]+|s3[[:space:]]+(rm|rb|mv)|s3api[[:space:]]+delete-[a-z-]+)([[:space:]]|$)'

if [[ "$cmd" =~ $iac ]]; then
  what="infrastructure change (${BASH_REMATCH[2]} ${BASH_REMATCH[4]})"
elif [[ "$cmd" =~ $aws ]]; then
  what="destructive AWS call"
else
  exit 0
fi

# Which AWS profile the command will use: --profile, an inline AWS_PROFILE=, then the env.
profile=""
[[ "$cmd" =~ --profile[=[:space:]]+([^[:space:]]+) ]] && profile=${BASH_REMATCH[1]}
[[ -z "$profile" && "$cmd" =~ AWS_PROFILE=([^[:space:]]+) ]] && profile=${BASH_REMATCH[1]}
profile=${profile:-${AWS_PROFILE:-default}}
profile=${profile//[\"\']/}

IFS=',' read -ra safe <<<"${ECC_SAFE_PROFILES:-}"
for p in "${safe[@]}"; do
  [[ -n "$p" && "$p" == "$profile" ]] && exit 0
done

jq -n --arg r "prod-guard: $what with AWS profile '$profile'. Confirm this is the intended account." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
