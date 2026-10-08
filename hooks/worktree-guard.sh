#!/usr/bin/env bash
# PreToolUse(Bash): before a git command that throws away local work, ask, and name what
# would be lost. Covers `git worktree remove` (it also deletes ignored files such as .env),
# `git reset --hard`, `git checkout -- <path>` / `git checkout .`, `git restore` of the working
# tree and `git clean -f`. When nothing would be lost the command passes without asking.

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[[ -n "$cmd" ]] || exit 0
[[ "$cmd" == *git* ]] || exit 0

# Ignored files that are only caches, safe to lose (the same list as the worktree skill).
cache_re='(^|/)(__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|\.import_linter_cache|\.hypothesis|\.cache|\.venv|node_modules|\.terraform|\.tofu|\.gradle|\.dart_tool|build|dist|target)/$|\.pyc$'
[[ -n ${WT_CACHE_RE:-} ]] && cache_re="$cache_re|$WT_CACHE_RE"

lost=()
dir=${cwd:-$PWD}

# Look at each command of a chain in order, following `cd` so `cd x && git ...` is checked in x.
while IFS= read -r part; do
  part="${part#"${part%%[![:space:]]*}"}"
  if [[ $part =~ ^cd[[:space:]]+([^[:space:]]+) ]]; then
    d=${BASH_REMATCH[1]//[\"\']/}; d=${d/#\~/$HOME}
    [[ $d == /* ]] || d="$dir/$d"
    dir=$d; continue
  fi
  [[ $part =~ (^|[[:space:]])git([[:space:]]|$) ]] || continue
  here=$dir
  [[ $part =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]] && { c=${BASH_REMATCH[1]//[\"\']/}; c=${c/#\~/$HOME}; [[ $c == /* ]] && here=$c || here="$dir/$c"; }
  git -C "$here" rev-parse --git-dir >/dev/null 2>&1 || continue
  sub=${part#*git }
  # Drop git's own options (-C dir, -c key=value, --no-pager...) so sub starts at the subcommand.
  while [[ $sub =~ ^(-[Cc][[:space:]]+[^[:space:]]+|--?[a-z][a-z-]*(=[^[:space:]]*)?)[[:space:]]+(.*) ]]; do
    sub=${BASH_REMATCH[3]}
  done

  if [[ $sub =~ worktree[[:space:]]+remove[[:space:]]+(.*) ]]; then
    target=""
    for a in ${BASH_REMATCH[1]}; do [[ $a == -* ]] || { target=${a//[\"\']/}; break; }; done
    [[ -n $target ]] || continue
    target=${target/#\~/$HOME}; [[ $target == /* ]] || target="$here/$target"
    [[ -d $target ]] || continue
    changes=$(git -C "$target" status --porcelain 2>/dev/null | head -5)
    ignored=$(git -C "$target" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | grep -Ev "$cache_re" | head -5)
    [[ -n $changes ]] && lost+=("uncommitted changes in $target: $(tr '\n' ' ' <<<"$changes")")
    [[ -n $ignored ]] && lost+=("ignored files that worktree remove deletes: $(tr '\n' ' ' <<<"$ignored")")
    b=$(git -C "$target" branch --show-current 2>/dev/null)
    if [[ -n $b ]]; then
      n=$(git -C "$target" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
      [[ $n != 0 ]] && lost+=("$n commit(s) on $b that are on no remote")
    fi
  elif [[ $sub =~ ^reset([[:space:]].*)?--hard ]]; then
    changes=$(git -C "$here" status --porcelain --untracked-files=no 2>/dev/null | head -5)
    [[ -n $changes ]] && lost+=("uncommitted changes in $here: $(tr '\n' ' ' <<<"$changes")")
    n=$(git -C "$here" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
    [[ $n != 0 ]] && lost+=("$n commit(s) on $(git -C "$here" branch --show-current) that are on no remote")
  elif [[ $sub =~ ^checkout([[:space:]]+-[^-][^[:space:]]*)*[[:space:]]+(--[[:space:]]|\.([[:space:]]|$)) || $sub =~ ^restore[[:space:]] && ! $sub =~ --staged([[:space:]]|$) ]]; then
    changes=$(git -C "$here" status --porcelain --untracked-files=no 2>/dev/null | head -5)
    [[ -n $changes ]] && lost+=("uncommitted changes in $here: $(tr '\n' ' ' <<<"$changes")")
  elif [[ $sub =~ ^clean([[:space:]].*)?[[:space:]]-[a-zA-Z]*f && ! $sub =~ [[:space:]]-[a-zA-Z]*n ]]; then
    if [[ $sub =~ [[:space:]]-[a-zA-Z]*[xX] ]]; then
      files=$(git -C "$here" status --porcelain --ignored 2>/dev/null | sed -n 's/^\(??\|!!\) //p' | grep -Ev "$cache_re" | head -5)
    else
      files=$(git -C "$here" status --porcelain 2>/dev/null | sed -n 's/^?? //p' | head -5)
    fi
    [[ -n $files ]] && lost+=("files git clean deletes in $here: $(tr '\n' ' ' <<<"$files")")
  fi
done < <(sed -E 's/(&&|\|\||;)/\n/g' <<<"$cmd")

[[ ${#lost[@]} -eq 0 ]] && exit 0
reason="worktree-guard: this would throw away local work. $(printf '%s; ' "${lost[@]}")Copy or commit it first, or confirm it is not needed. To remove a worktree, the worktree skill's wt.sh rm keeps ignored files."
jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
