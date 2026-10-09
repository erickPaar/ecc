#!/usr/bin/env bash
# Keep a session's unfinished work from living only as uncommitted files.
#   wip-commit.sh track    PostToolUse(Edit|Write|MultiEdit|NotebookEdit): remember which linked
#                          worktree the session edited
#   wip-commit.sh commit   SessionEnd: in each of those worktrees, commit the tracked changes as a
#                          local "wip:" commit and note it in the worklog
# Only linked worktrees (never the main checkout), never the default branch, never during a
# rebase, merge or cherry-pick, only files git already tracks (git add -u: a new file that
# should be ignored is never swept in), and never pushed. ECC_WIP_COMMIT=0 turns it off.
# Any failure passes silently: a hook must not get in the way of ending a session.

[[ ${ECC_WIP_COMMIT:-1} == 0 ]] && exit 0
input=$(cat)
{ IFS= read -r session; IFS= read -r file; } < <(jq -r '(.session_id // "" | gsub("[^A-Za-z0-9_-]"; "")), (.tool_input.file_path // .tool_input.notebook_path // "")' <<<"$input" 2>/dev/null)
[[ -n $session ]] || exit 0
state_dir=${ECC_WIP_STATE_DIR:-$HOME/.claude/wip-commit}
state="$state_dir/$session"

case ${1:-} in
  track)
    [[ -n $file ]] || exit 0
    dir=$(dirname "$file"); [[ -d $dir ]] || exit 0
    top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
    common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
    [[ $common == "$top/.git" ]] && exit 0 # the main checkout, not a linked worktree
    mkdir -p "$state_dir" 2>/dev/null || exit 0
    grep -qxF "$top" "$state" 2>/dev/null || echo "$top" >>"$state"
    ;;
  commit)
    [[ -f $state ]] || exit 0
    while IFS= read -r top; do
      [[ -d $top ]] || continue
      branch=$(git -C "$top" branch --show-current 2>/dev/null)
      [[ -n $branch ]] || continue
      default=$(git -C "$top" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); default=${default#origin/}
      [[ $branch == "${default:-main}" || $branch == main || $branch == master ]] && continue
      gd=$(git -C "$top" rev-parse --absolute-git-dir 2>/dev/null) || continue
      [[ -e $gd/rebase-merge || -e $gd/rebase-apply || -e $gd/MERGE_HEAD || -e $gd/CHERRY_PICK_HEAD ]] && continue
      git -C "$top" diff --quiet HEAD 2>/dev/null && continue # nothing tracked changed
      untracked=$(git -C "$top" ls-files --others --exclude-standard 2>/dev/null | head -10)
      msg="wip: session ended with uncommitted changes"
      [[ -n $untracked ]] && msg+=$'\n\nUntracked files left out:\n'"$untracked"
      git -C "$top" add -u 2>/dev/null \
        && git -C "$top" -c core.hooksPath=/dev/null commit -q -m "$msg" 2>/dev/null || continue
      sha=$(git -C "$top" rev-parse --short HEAD)
      log="$(dirname "$top")/$(basename "$top").md"
      [[ -f $log ]] && printf -- '- %s: session ended; work-in-progress kept in local commit %s (not pushed)\n' "$(date '+%Y-%m-%d %H:%M')" "$sha" >>"$log"
    done <"$state"
    rm -f "$state"
    ;;
esac
exit 0
