#!/usr/bin/env bash
# Keep a copy of a session's unfinished work, without touching git.
#   wip-snapshot.sh track  PostToolUse(Edit|Write|MultiEdit|NotebookEdit): remember which files the
#                          session edited inside worktrees made by the worktree skill
#   wip-snapshot.sh save   SessionEnd: for each of those worktrees, save the session's uncommitted
#                          changes to those files as a patch in .claude/worktrees/.wip/, and note it
#                          in the worktree's worklog with the command that brings them back.
#
# It only reads git, with plumbing: `git diff-index` never refreshes or locks the index (porcelain
# `git diff` does, when a file's timestamp changed but not its content), and neither it nor the
# `--no-index` diff below follows the user's diff settings (color, prefixes, external tools,
# textconv). A run cut short by the SessionEnd budget leaves at most a stray .tmp, which the next
# save cleans up. It covers only worktrees under .claude/worktrees/, never a main checkout or a
# submodule; a path outside the worktree (a symlink's target) is skipped. Edits made through Bash
# are not tracked. ECC_WIP_SNAPSHOT=0 turns it off. Any failure passes silently.

[[ ${ECC_WIP_SNAPSHOT:-1} == 0 ]] && exit 0
input=$(cat)
{ IFS= read -r session; IFS= read -r file; } < <(jq -r '(.session_id // "" | gsub("[^A-Za-z0-9_-]"; "")), (.tool_input.file_path // .tool_input.notebook_path // "")' <<<"$input" 2>/dev/null)
[[ -n $session ]] || exit 0
state_dir=${ECC_WIP_STATE_DIR:-$HOME/.claude/wip-snapshot}
state="$state_dir/$session"
SEP=$'\x1f' # between worktree and file in the state file: a tab can be part of a file name

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
    # The path as the session named it, relative to the worktree, without resolving symlinks.
    dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P) || exit 0
    case $dir/ in "$top"/*) ;; *) exit 0 ;; esac
    rel=${dir#"$top"}; rel=${rel#/}; rel=${rel:+$rel/}$(basename "$file")
    mkdir -p "$state_dir" 2>/dev/null || exit 0
    find "$state_dir" -type f -mtime +7 -delete 2>/dev/null # sessions killed before their SessionEnd
    line="$top$SEP$rel"
    grep -qxF -- "$line" "$state" 2>/dev/null || printf '%s\n' "$line" >>"$state"
    ;;
  save)
    [[ -f $state ]] || exit 0
    while IFS= read -r top; do
      [[ -d $top ]] || continue
      mapfile -t files < <(awk -F "$SEP" -v t="$top" '$1 == t { print $2 }' "$state")
      [[ ${#files[@]} -gt 0 ]] || continue
      name=$(basename "$top")
      wip="$(dirname "$top")/.wip"
      mkdir -p "$wip" 2>/dev/null || continue
      find "$wip" -maxdepth 1 -name '*.tmp' -mmin +60 -delete 2>/dev/null # left by runs that were killed
      patch="$wip/$name-$(date +%Y%m%d-%H%M%S)-${session:0:8}.patch"
      {
        # Tracked files: what differs from HEAD, staged or not. Plumbing: no index refresh, no config.
        GIT_LITERAL_PATHSPECS=1 git -C "$top" diff-index -p --binary --full-index HEAD -- "${files[@]}" 2>/dev/null
        # Files the session created that git doesn't track yet.
        while IFS= read -r -d '' f; do
          (cd "$top" && git diff --no-index --binary --no-color --no-ext-diff --no-textconv \
            --src-prefix=a/ --dst-prefix=b/ /dev/null "$f" 2>/dev/null)
        done < <(GIT_LITERAL_PATHSPECS=1 git -C "$top" ls-files -z --others --exclude-standard -- "${files[@]}" 2>/dev/null)
      } >"$patch.tmp"
      if [[ -s $patch.tmp ]]; then
        mv -f "$patch.tmp" "$patch"
        log="$(dirname "$top")/$name.md"
        [[ -f $log ]] && printf -- '- %s: session ended with uncommitted changes; saved in .wip/%s (restore: git -C %s apply --reject %s)\n' \
          "$(date '+%Y-%m-%d %H:%M')" "$(basename "$patch")" "$top" "$patch" >>"$log"
      else
        rm -f "$patch.tmp"
      fi
    done < <(cut -d "$SEP" -f1 "$state" | sort -u)
    rm -f "$state"
    ;;
esac
exit 0
