#!/usr/bin/env bash
# Keep a copy of a session's unfinished work, without touching git.
#   wip-snapshot.sh track  PostToolUse(Edit|Write|MultiEdit|NotebookEdit): remember which files the
#                          session edited inside worktrees made by the worktree skill
#   wip-snapshot.sh save   SessionEnd: for each of those worktrees, save the session's uncommitted
#                          changes to those files as a patch in .claude/worktrees/.wip/, and note it
#                          in the worktree's worklog. `git apply <patch>` brings them back.
#
# It only reads git: no index write (GIT_OPTIONAL_LOCKS=0), no commit, no ref, no hook. A run cut
# short by the SessionEnd budget loses at most its own patch, never anyone's work. It covers only
# worktrees under .claude/worktrees/, never a main checkout or a submodule. Edits made through Bash
# are not tracked. ECC_WIP_SNAPSHOT=0 turns it off. Any failure passes silently.

[[ ${ECC_WIP_SNAPSHOT:-1} == 0 ]] && exit 0
export GIT_OPTIONAL_LOCKS=0
input=$(cat)
{ IFS= read -r session; IFS= read -r file; } < <(jq -r '(.session_id // "" | gsub("[^A-Za-z0-9_-]"; "")), (.tool_input.file_path // .tool_input.notebook_path // "")' <<<"$input" 2>/dev/null)
[[ -n $session ]] || exit 0
state_dir=${ECC_WIP_STATE_DIR:-$HOME/.claude/wip-snapshot}
state="$state_dir/$session"

skill_worktree() { # the toplevel, when $1 is inside a worktree made by the worktree skill
  local dir top gitdir common
  dir=$(dirname "$1"); [[ -d $dir ]] || return 1
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  gitdir=$(git -C "$top" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [[ $gitdir == "$common" ]] && return 1 # a main checkout (any layout) or a submodule
  [[ $top == "$(dirname "$common")/.claude/worktrees/"* ]] || return 1
  echo "$top"
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
  save)
    [[ -f $state ]] || exit 0
    while IFS= read -r top; do
      [[ -d $top ]] || continue
      mapfile -t files < <(awk -F '\t' -v t="$top" '$1 == t { print $2 }' "$state")
      [[ ${#files[@]} -gt 0 ]] || continue
      name=$(basename "$top")
      wip="$(dirname "$top")/.wip"
      patch="$wip/$name-$(date +%Y%m%d-%H%M%S)-${session:0:8}.patch"
      mkdir -p "$wip" 2>/dev/null || continue
      {
        # Tracked files: what differs from HEAD, staged or not.
        GIT_LITERAL_PATHSPECS=1 git -C "$top" diff --binary HEAD -- "${files[@]}" 2>/dev/null
        # Files the session created that git doesn't track yet.
        while IFS= read -r -d '' f; do
          (cd "$top" && git diff --binary --no-index /dev/null "$f" 2>/dev/null)
        done < <(GIT_LITERAL_PATHSPECS=1 git -C "$top" ls-files -z --others --exclude-standard -- "${files[@]}" 2>/dev/null)
      } >"$patch.tmp"
      if [[ -s $patch.tmp ]]; then
        mv -f "$patch.tmp" "$patch"
        log="$(dirname "$top")/$name.md"
        [[ -f $log ]] && printf -- '- %s: session ended with uncommitted changes; saved in %s (restore: git apply %s)\n' \
          "$(date '+%Y-%m-%d %H:%M')" "${patch#"$(dirname "$top")/"}" "$patch" >>"$log"
      else
        rm -f "$patch.tmp"
      fi
    done < <(cut -f1 "$state" | sort -u)
    rm -f "$state"
    ;;
esac
exit 0
