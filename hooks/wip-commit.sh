#!/usr/bin/env bash
# Keep a session's unfinished work from living only as uncommitted files.
#   wip-commit.sh track    PostToolUse(Edit|Write|MultiEdit|NotebookEdit): remember which files the
#                          session edited inside worktrees made by the worktree skill
#   wip-commit.sh commit   SessionEnd: commit those files, where they changed, as a local "wip:"
#                          commit per worktree, and note it in the worktree's worklog
#
# What it never does:
#   - push;
#   - touch the main checkout, a submodule, or a worktree outside .claude/worktrees/;
#   - commit on the default branch (origin/HEAD, init.defaultBranch, main, master, develop, trunk);
#   - commit during a merge, rebase, cherry-pick, revert or bisect, or with unmerged files;
#   - commit when something is already staged (a staging made on purpose is left as it is);
#   - commit a file another session edited, or a file git doesn't track yet;
#   - skip the repository's pre-commit hook: if it refuses (a secret scanner, say), there is no commit.
#
# It never stages in the real index: the commit is built in a temporary index and the branch moves
# only once it exists, so a run cut short leaves nothing half done. Claude Code gives SessionEnd
# hooks 1.5 s; raise it with CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS if your pre-commit hook is slow.
# ECC_WIP_COMMIT=0 turns it off. Any failure passes silently.

[[ ${ECC_WIP_COMMIT:-1} == 0 ]] && exit 0
input=$(cat)
{ IFS= read -r session; IFS= read -r file; } < <(jq -r '(.session_id // "" | gsub("[^A-Za-z0-9_-]"; "")), (.tool_input.file_path // .tool_input.notebook_path // "")' <<<"$input" 2>/dev/null)
[[ -n $session ]] || exit 0
state_dir=${ECC_WIP_STATE_DIR:-$HOME/.claude/wip-commit}
state="$state_dir/$session"

skill_worktree() { # prints the worktree's toplevel when $1 is inside a worktree made by the worktree skill
  local dir top gitdir common
  dir=$(dirname "$1"); [[ -d $dir ]] || return 1
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  gitdir=$(git -C "$top" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [[ $gitdir == "$common" ]] && return 1                    # a main checkout (any layout) or a submodule
  [[ $top == "$(dirname "$common")/.claude/worktrees/"* ]] || return 1
  echo "$top"
}

default_branch() {
  local top=$1 d
  d=$(git -C "$top" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) && echo "${d#origin/}"
  git -C "$top" config init.defaultBranch 2>/dev/null
  printf '%s\n' main master develop trunk
}

case ${1:-} in
  track)
    [[ -n $file ]] || exit 0
    top=$(skill_worktree "$file") || exit 0
    rel=$(realpath -m --relative-to="$top" "$file" 2>/dev/null) || exit 0
    mkdir -p "$state_dir" 2>/dev/null || exit 0
    find "$state_dir" -type f -mtime +7 -delete 2>/dev/null # sessions killed before their SessionEnd
    line="$top"$'\t'"$rel"
    grep -qxF "$line" "$state" 2>/dev/null || printf '%s\n' "$line" >>"$state"
    ;;
  commit)
    [[ -f $state ]] || exit 0
    while IFS= read -r top; do
      [[ -d $top ]] || continue
      branch=$(git -C "$top" branch --show-current 2>/dev/null)
      [[ -n $branch ]] || continue
      default_branch "$top" | grep -qxF "$branch" && continue
      gd=$(git -C "$top" rev-parse --absolute-git-dir 2>/dev/null) || continue
      for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD sequencer BISECT_LOG; do
        [[ -e $gd/$f ]] && continue 2
      done
      [[ -z $(git -C "$top" ls-files -u 2>/dev/null) ]] || continue
      git -C "$top" diff --cached --quiet 2>/dev/null || continue # something staged on purpose
      mapfile -t files < <(awk -F '\t' -v t="$top" '$1 == t { print $2 }' "$state")
      mapfile -t changed < <(GIT_LITERAL_PATHSPECS=1 git -C "$top" diff --name-only HEAD -- "${files[@]}" 2>/dev/null)
      [[ ${#changed[@]} -gt 0 ]] || continue
      # Build the commit in a temporary index; the real index and the branch move only once it exists.
      tmp=$(mktemp) || continue
      cp "$gd/index" "$tmp" 2>/dev/null || { rm -f "$tmp"; continue; }
      msg="wip: session ended with uncommitted changes"$'\n\n'"Files this session edited, kept here:"$'\n'"$(printf '  %s\n' "${changed[@]}")"
      others=$(git -C "$top" diff --name-only HEAD 2>/dev/null | grep -vxF -f <(printf '%s\n' "${changed[@]}") | head -10)
      created=$(git -C "$top" ls-files --others --exclude-standard -- "${files[@]}" 2>/dev/null | head -10)
      [[ -n $created ]] && msg+=$'\n\n'"New files this session wrote, left out (git doesn't track them yet):"$'\n'"$(sed 's/^/  /' <<<"$created")"
      [[ -n $others ]] && msg+=$'\n\n'"Changes left uncommitted (not this session's edits):"$'\n'"$(sed 's/^/  /' <<<"$others")"
      if GIT_INDEX_FILE=$tmp GIT_LITERAL_PATHSPECS=1 git -C "$top" add -- "${changed[@]}" 2>/dev/null \
        && GIT_INDEX_FILE=$tmp git -C "$top" -c commit.gpgsign=false commit -q -m "$msg" 2>/dev/null; then
        git -C "$top" reset -q 2>/dev/null # the real index now matches the new HEAD; the files are untouched
        sha=$(git -C "$top" rev-parse --short HEAD)
        log="$(dirname "$top")/$(basename "$top").md"
        [[ -f $log ]] && printf -- '- %s: session ended; work-in-progress kept in local commit %s (not pushed)\n' "$(date '+%Y-%m-%d %H:%M')" "$sha" >>"$log"
      fi
      rm -f "$tmp"
    done < <(cut -f1 "$state" | sort -u)
    rm -f "$state"
    ;;
esac
exit 0
