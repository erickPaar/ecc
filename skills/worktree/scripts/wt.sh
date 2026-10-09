#!/usr/bin/env bash
# Git worktrees inside each repository, at <repo>/.claude/worktrees/<name>.
#   wt.sh add <name> [<branch>] [<base>]   new worktree on a new branch; <branch> defaults to <name>,
#                                          <base> to the remote's default branch. Also writes its
#                                          worklog, .claude/worktrees/<name>.md
#   wt.sh rm <name|path> [--keep-branch]   remove one, after checking nothing would be lost
#   wt.sh list [<repo>...]                 every worktree of the repositories (default: the one you are
#                                          in, or every repository under the folders in WT_ROOTS)
# Run add and rm from inside the repository (the main checkout or any of its worktrees).
set -euo pipefail

DIR=.claude/worktrees
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
die() { echo "wt: $*" >&2; exit 1; }

main_root() { # the main checkout of the repository at $1 (default: the one we are in)
  local common
  common=$(git -C "${1:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git repository"
  dirname "$common"
}

default_base() { # the remote's default branch, else the local HEAD
  local root=$1 ref
  if ref=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); then echo "$ref"; return; fi
  ref=$(git -C "$root" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p')
  if [[ -n $ref ]] && git -C "$root" rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then echo "origin/$ref"; return; fi
  git -C "$root" rev-parse -q --verify HEAD >/dev/null || die "no commit to start from; pass a base"
  echo HEAD
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
  git -C "$root" fetch -q origin 2>/dev/null || true
  if [[ -z $base ]] && git -C "$root" rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
    base=origin/$branch # a branch only on the remote, e.g. a pull request to review: track it
  fi
  base=${base:-$(default_base "$root")}
  git -C "$root" rev-parse -q --verify "$base^{commit}" >/dev/null || die "no commit $base"
  ensure_exclude "$root"
  git -C "$root" worktree add -q -b "$branch" "$path" "$base"
  [[ $base == "origin/$branch" ]] && git -C "$path" branch -q --set-upstream-to="origin/$branch"
  # The worklog sits beside the worktree, outside its tree: never committed, readable by every session.
  local log="$root/$DIR/$name.md"
  if [[ ! -e $log ]]; then
    sed -e "s|{{name}}|$name|; s|{{branch}}|$branch|; s|{{base}}|$base|; s|{{date}}|$(date +%Y-%m-%d)|" \
      -e "s|{{owner}}|${WT_OWNER:-$(git -C "$root" config user.name 2>/dev/null || true)}|" \
      "$HERE/../templates/worklog.md" >"$log"
  fi
  echo "$path  [$branch from $base]"
  echo "worklog: $log"
}

in_use() { # a process or a compose project working inside the worktree
  local path=$1 pid cwd
  for pid in $(pgrep -u "$(id -u)" . 2>/dev/null); do
    [[ $pid == "$$" || $pid == "$PPID" ]] && continue
    # Our own pipeline siblings (wt.sh rm x | cat) share our parent; they are not "in use".
    [[ $(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) == "$PPID" ]] && continue
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

merged() { # the branch's content reached the default branch, though a squash gave it new ids
  local root=$1 path=$2 branch=$3 base mb slug state
  local -a files=()
  base=$(default_base "$root" 2>/dev/null) || return 1
  git -C "$root" fetch -q origin 2>/dev/null || true
  mb=$(git -C "$path" merge-base HEAD "$base" 2>/dev/null) || return 1
  # Every file the branch changed has the branch's content on the default branch now.
  mapfile -d '' -t files < <(git -C "$path" diff -z --name-only "$mb" HEAD)
  if [[ ${#files[@]} -gt 0 ]] && git -C "$path" diff --quiet HEAD "$base" -- "${files[@]}" 2>/dev/null; then
    echo "the commits on $branch are on $base under other ids (their files match)"; return 0
  fi
  # Or GitHub says the pull request for this exact head was merged.
  slug=$(git -C "$root" remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##' || true)
  if [[ -n $slug ]] && command -v gh >/dev/null 2>&1; then
    state=$(gh pr list -R "$slug" --head "$branch" --state merged --json headRefOid \
      -q "map(select(.headRefOid == \"$(git -C "$path" rev-parse HEAD)\")) | length" 2>/dev/null || echo 0)
    [[ $state != 0 ]] && { echo "the pull request for $branch at this head was merged"; return 0; }
  fi
  return 1
}

cmd_rm() {
  local name=${1:?usage: wt.sh rm <name|path> [--keep-branch]} keep=${2:-} root path branch dirty unpushed backup user entry f
  if [[ -d $name && $name == */* ]]; then root=$(main_root "$name"); path=$name; else root=$(main_root); path="$root/$DIR/$name"; fi
  [[ -d $path ]] || die "no worktree $name"
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
    if [[ $unpushed != 0 ]] && ! merged "$root" "$path" "$branch"; then
      die "$unpushed commit(s) on $branch exist only here, and their content is not on the default branch; push them, or check where they went"
    fi
  fi

  # git worktree remove deletes ignored files too. Copy out anything that is not a cache, and check the copies.
  local -a keep_files=()
  while IFS= read -r -d '' entry; do
    [[ $entry == '!! '* ]] || continue
    f=${entry#'!! '}
    [[ $f =~ $CACHE_RE ]] || keep_files+=("$f")
  done < <(git -C "$path" status --porcelain=v1 -z --ignored)
  local log
  log="$root/$DIR/$(basename "$path").md"
  if [[ ${#keep_files[@]} -gt 0 || -e $log ]]; then
    backup="$root/$DIR/.removed/$(basename "$path")-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
  fi
  if [[ ${#keep_files[@]} -gt 0 ]]; then
    for f in "${keep_files[@]}"; do
      mkdir -p "$backup/$(dirname "$f")"
      if ! cp -a "$path/$f" "$backup/$f" 2>/dev/null || [[ ! -e $backup/$f && ! -L $backup/$f ]]; then
        rm -rf "$backup"; die "could not copy $f out; nothing was removed"
      fi
    done
    echo "kept the ignored files in $backup:"; printf '  %s\n' "${keep_files[@]}"
  fi

  git -C "$root" worktree remove --force "$path"
  git -C "$root" worktree prune
  echo "removed $path"
  if [[ -e $log ]]; then mv "$log" "$backup/worklog.md" && echo "kept the worklog in $backup/worklog.md"; fi
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
  local repos=("$@") r slug w b d pr size log
  if [[ ${#repos[@]} -eq 0 ]]; then
    if [[ -n ${WT_ROOTS:-} ]]; then mapfile -t repos < <(repos_in); else repos=("$(main_root)"); fi
  fi
  for r in "${repos[@]}"; do
    [[ -d $r/.git ]] || die "no repository at $r"
    slug=$(git -C "$r" remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##' || true)
    echo "== $(basename "$r")${slug:+  ($slug)}"
    while IFS= read -r w; do
      if [[ ! -d $w ]]; then printf '  %-55s (folder gone: git worktree prune)\n' "${w/#$HOME/\~}"; continue; fi
      b=$(git -C "$w" branch --show-current 2>/dev/null) || b="?"
      d=$(git -C "$w" status --porcelain 2>/dev/null | wc -l || true)
      size=$(du -sh "$w" 2>/dev/null | cut -f1 || true)
      pr=""
      if [[ -n $b && -n $slug ]] && command -v gh >/dev/null 2>&1; then
        pr=$(gh pr list -R "$slug" --head "$b" --state all --json number,state \
          -q 'max_by(.number) // empty | "#\(.number) \(.state)"' 2>/dev/null || true)
      fi
      printf '  %-55s %-35s %6s  changes=%-3s %s\n' "${w/#$HOME/\~}" "${b:-(detached)}" "$size" "$d" "$pr"
      log="$r/$DIR/$(basename "$w").md"
      if [[ $w == "$r/$DIR/"* && -f $log ]]; then
        sed -n 's/^- owner: \(..*\)/      owner:  \1/p; s/^- status: \(..*\)/      status: \1/p; s/^- next: \(..*\)/      next:   \1/p' "$log"
      fi
    done < <(git -C "$r" worktree list --porcelain | sed -n 's/^worktree //p')
  done
}

case ${1:-} in
  add) shift; cmd_add "$@" ;;
  rm) shift; cmd_rm "$@" ;;
  list) shift; cmd_list "$@" ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
