#!/usr/bin/env bash
# Git worktrees inside each repository, at <repo>/.claude/worktrees/<name>.
#   wt.sh add <name> [<branch>] [<base>]   new worktree on a new branch; <branch> defaults to <name>,
#                                          <base> to the remote's default branch
#   wt.sh rm <name|path> [--keep-branch]   remove one, after checking nothing would be lost
#   wt.sh list [<repo>...]                 every worktree of the repositories (default: the one you are
#                                          in, or every repository under the folders in WT_ROOTS)
# Run add and rm from inside the repository (the main checkout or any of its worktrees).
set -euo pipefail

DIR=.claude/worktrees
die() { echo "wt: $*" >&2; exit 1; }

main_root() { # the main checkout of the repository we are in
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git repository"
  dirname "$common"
}

default_base() { # origin/HEAD when the remote has one, else origin/main
  local root=$1 ref
  ref=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) || ref=origin/main
  echo "$ref"
}

ensure_exclude() { # .claude/worktrees/ never shows in git status and is never committed
  local f="$1/.git/info/exclude"
  mkdir -p "$(dirname "$f")"
  grep -qx "$DIR/" "$f" 2>/dev/null || echo "$DIR/" >>"$f"
}

# Ignored files that are only caches, safe to lose. Extend with WT_CACHE_RE.
CACHE_RE='(^|/)(__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|\.import_linter_cache|\.hypothesis|\.cache|\.venv|node_modules|\.terraform|\.tofu|\.gradle|\.dart_tool|build|dist|target)/$|\.pyc$'
[[ -n ${WT_CACHE_RE:-} ]] && CACHE_RE="$CACHE_RE|$WT_CACHE_RE"

cmd_add() {
  local name=${1:?usage: wt.sh add <name> [branch] [base]} branch=${2:-$1} base=${3:-} root path
  root=$(main_root); path="$root/$DIR/$name"
  [[ -e $path ]] && die "$path already exists; look at it (wt.sh list) instead of reusing it"
  if git -C "$root" show-ref -q --verify "refs/heads/$branch"; then
    die "branch $branch already exists; check whose it is (git log $branch) before using it, or pick another name"
  fi
  ensure_exclude "$root"
  git -C "$root" fetch -q origin 2>/dev/null || true
  base=${base:-$(default_base "$root")}
  git -C "$root" worktree add -q -b "$branch" "$path" "$base"
  echo "$path  [$branch from $base]"
}

in_use() { # a process or a compose project working inside the worktree
  local path=$1 pid cwd
  for pid in $(pgrep -u "$(id -u)" . 2>/dev/null); do
    [[ $pid == "$$" || $pid == "$PPID" ]] && continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
    [[ $cwd == "$path" || $cwd == "$path"/* ]] && { echo "process $pid ($(cat "/proc/$pid/comm" 2>/dev/null)) runs in $cwd"; return 0; }
  done
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}} {{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
      | awk -v p="$path" '$2 == p || index($2, p "/") == 1 { print "container " $1 " runs from " $2; found = 1 } END { exit !found }' \
      && return 0
  fi
  return 1
}

cmd_rm() {
  local name=${1:?usage: wt.sh rm <name|path> [--keep-branch]} keep=${2:-} root path branch dirty ignored unpushed backup user
  root=$(main_root); path="$root/$DIR/$name"
  [[ -d $path ]] || path=$(cd "$name" 2>/dev/null && pwd -P) || die "no worktree $name"
  cd "$root" # so this script's own subshells don't count as running inside the worktree
  path=$(cd "$path" && pwd -P)
  [[ $path == "$(cd "$root" && pwd -P)" ]] && die "that is the main checkout"
  git -C "$root" worktree list --porcelain | grep -qx "worktree $path" || die "$path is not a worktree of $root"
  branch=$(git -C "$path" branch --show-current)

  if user=$(in_use "$path"); then die "in use: $user; stop it first"; fi

  dirty=$(git -C "$path" status --porcelain)
  [[ -z $dirty ]] || die "uncommitted changes in $path; commit, push or ask whose they are:
$dirty"

  if [[ -n $branch ]]; then
    git -C "$path" fetch -q origin "$branch" 2>/dev/null || true
    if git -C "$path" rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
      unpushed=$(git -C "$path" rev-list --count "origin/$branch..HEAD")
    else
      unpushed=$(git -C "$path" rev-list --count HEAD --not --remotes)
    fi
    [[ $unpushed == 0 ]] || die "$unpushed commit(s) on $branch exist only here; push them, or check their content is in the default branch (a squash merge gives it new commit ids)"
  fi

  # git worktree remove deletes ignored files too. Copy out anything that is not a cache, and check the copies.
  ignored=$(git -C "$path" status --porcelain --ignored | sed -n 's/^!! //p' | grep -Ev "$CACHE_RE" || true)
  if [[ -n $ignored ]]; then
    backup="$root/$DIR/.removed/$(basename "$path")-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    while IFS= read -r f; do
      mkdir -p "$backup/$(dirname "$f")"
      cp -a "$path/$f" "$backup/$f" 2>/dev/null || die "could not copy $f out; nothing was removed"
      [[ -e $backup/$f ]] || die "copy of $f missing in $backup; nothing was removed"
    done <<<"$ignored"
    echo "kept the ignored files in $backup:"; sed 's/^/  /' <<<"$ignored"
  fi

  git -C "$root" worktree remove --force "$path"
  git -C "$root" worktree prune
  echo "removed $path"
  if [[ -n $branch && $keep != --keep-branch ]]; then
    git -C "$root" branch -D "$branch" >/dev/null && echo "deleted local branch $branch (still on origin if it was pushed)"
  fi
}

repos_in() { # the repositories directly inside each folder of WT_ROOTS (colon-separated)
  local root r
  IFS=':' read -ra roots <<<"$WT_ROOTS"
  for root in "${roots[@]}"; do
    [[ -d $root/.git ]] && { echo "$root"; continue; }
    for r in "$root"/*/; do [[ -d $r/.git ]] && echo "${r%/}"; done
  done
}

cmd_list() {
  local repos=("$@") r slug w b d pr size
  if [[ ${#repos[@]} -eq 0 ]]; then
    if [[ -n ${WT_ROOTS:-} ]]; then mapfile -t repos < <(repos_in); else repos=("$(main_root)"); fi
  fi
  for r in "${repos[@]}"; do
    [[ -d $r/.git ]] || die "no repository at $r"
    slug=$(git -C "$r" remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')
    echo "== $(basename "$r")${slug:+  ($slug)}"
    while IFS= read -r w; do
      b=$(git -C "$w" branch --show-current 2>/dev/null) || b="?"
      d=$(git -C "$w" status --porcelain 2>/dev/null | wc -l)
      size=$(du -sh "$w" 2>/dev/null | cut -f1)
      pr=""
      if [[ -n $b && -n $slug ]] && command -v gh >/dev/null 2>&1; then
        pr=$(gh pr list -R "$slug" --head "$b" --state all --json number,state \
          -q 'max_by(.number) // empty | "#\(.number) \(.state)"' 2>/dev/null || true)
      fi
      printf '  %-55s %-35s %6s  changes=%-3s %s\n' "${w/#$HOME/\~}" "${b:-(detached)}" "$size" "$d" "$pr"
    done < <(git -C "$r" worktree list --porcelain | sed -n 's/^worktree //p')
  done
}

case ${1:-} in
  add) shift; cmd_add "$@" ;;
  rm) shift; cmd_rm "$@" ;;
  list) shift; cmd_list "$@" ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
