#!/usr/bin/env bash
# PreToolUse(Bash): before a git command that throws away local work, ask, and name what
# would be lost. Covers `git worktree remove` (it also deletes ignored files such as .env),
# `git reset --hard`, `git checkout [<tree-ish>] -- <path>` / `checkout .` / `checkout -f`,
# `git switch --discard-changes` / `-f`, `git restore` of the working tree and `git clean -f`.
# When nothing would be lost the command passes without asking. Any failure passes too.

# One jq call: the cwd on the first line, the command after it.
{ IFS= read -r cwd; cmd=$(cat); } < <(jq -r '(.cwd // "" | gsub("\n"; " ")), (.tool_input.command // "")' 2>/dev/null)
[[ -n "$cmd" && "$cmd" == *git* ]] || exit 0
command -v python3 >/dev/null || exit 0
export GIT_OPTIONAL_LOCKS=0

# Ignored files that are only caches, safe to lose (the same list as the worktree skill).
cache_re='(^|/)(__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|\.import_linter_cache|\.hypothesis|\.cache|\.venv|node_modules|\.terraform|\.tofu|\.gradle|\.dart_tool|build|dist|target)/$|\.pyc$'
[[ -n ${WT_CACHE_RE:-} ]] && cache_re="$cache_re|$WT_CACHE_RE"

# Split the command into simple commands (on && || ; | & newlines and parentheses), each as
# its shell words, one command per line with words separated by \x1f.
commands=$(python3 -I - "$cmd" <<'PY' 2>/dev/null
import shlex, sys
seps = set(";&|()<>\n")
lexer = shlex.shlex(sys.argv[1], posix=True, punctuation_chars="".join(seps))
lexer.whitespace = " \t\r"
lexer.whitespace_split = True
lexer.commenters = ""  # bash comments only start a word; handled below, so a # never eats the newline
words, out, comment = [], [], False
try:
    for tok in lexer:
        if tok and set(tok) <= seps:
            if words: out.append(words)
            words = []
            if "\n" in tok: comment = False
        elif comment or tok.startswith("#"):
            comment = True
        else:
            words.append(tok)
except ValueError:
    pass
if words: out.append(words)
for w in out:
    print("\x1f".join(w))
PY
) || exit 0

abs() { local p=${1/#\~/$HOME}; [[ $p == /* ]] && echo "$p" || echo "$2/$p"; }
lost=()
dir=${cwd:-$PWD}

while IFS=$'\x1f' read -ra w; do
  [[ ${#w[@]} -gt 0 ]] || continue
  # Skip what can come before the program: VAR=value, keywords, wrappers and their options.
  i=0
  while (( i < ${#w[@]} )); do
    case ${w[i]} in
      [A-Za-z_]*=*|env|command|nohup|time|xargs|'!'|'{'|'$'|if|then|else|elif|do|while|until) ((i++)) ;;
      sudo) ((i++)); while [[ ${w[i]:-} == -* ]]; do [[ ${w[i]} == -[ugCDhpRrTt] ]] && ((i++)); ((i++)); done ;;
      *) break ;;
    esac
  done
  (( i < ${#w[@]} )) || continue
  prog=${w[i]##*/}
  if [[ $prog == cd || $prog == pushd ]]; then
    if [[ -n ${w[i+1]:-} && ${w[i+1]} != -* ]]; then d=$(abs "${w[i+1]}" "$dir"); [[ -d $d ]] && dir=$d; fi
    continue
  fi
  [[ $prog == git ]] || continue
  ((i++))
  here=$dir
  # git's own options before the subcommand.
  while (( i < ${#w[@]} )) && [[ ${w[i]} == -* ]]; do
    case ${w[i]} in
      -C) d=$(abs "${w[i+1]:-.}" "$dir"); [[ -d $d ]] && here=$d; ((i += 2)) ;;
      -c) ((i += 2)) ;;
      *) ((i++)) ;;
    esac
  done
  sub=${w[i]:-}; args=("${w[@]:i+1}")
  git -C "$here" rev-parse --git-dir >/dev/null 2>&1 || continue

  has() { local a; for a in "${args[@]}"; do [[ $a =~ $1 ]] && return 0; done; return 1; }
  changes() { git -C "$1" status --porcelain --untracked-files=no 2>/dev/null | head -5 | tr '\n' ' '; }

  case $sub in
    worktree)
      [[ ${args[0]:-} == remove ]] || continue
      target=""
      for a in "${args[@]:1}"; do [[ $a == -* ]] || { target=$a; break; }; done
      [[ -n $target ]] || continue
      t=$(abs "$target" "$here")
      if [[ ! -d $t ]]; then # git also takes the worktree's last path component
        t=$(git -C "$here" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' \
          | awk -v n="$target" '{ m = $0; sub(".*/", "", m) } m == n { print; exit }')
      fi
      [[ -n $t && -d $t ]] || continue
      c=$(git -C "$t" status --porcelain 2>/dev/null | head -5 | tr '\n' ' ')
      [[ -n $c ]] && lost+=("uncommitted changes in $t: $c")
      ig=$(git -C "$t" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | grep -Ev "$cache_re" | head -5 | tr '\n' ' ')
      [[ -n $ig ]] && lost+=("ignored files that worktree remove deletes: $ig")
      n=$(git -C "$t" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
      [[ $n != 0 ]] && lost+=("$n commit(s) in $t that are on no remote")
      ;;
    reset)
      has '^--hard$' || continue
      c=$(changes "$here"); [[ -n $c ]] && lost+=("uncommitted changes in $here: $c")
      target=HEAD
      for a in "${args[@]}"; do [[ $a == -* ]] || { target=$a; break; }; done
      n=$(git -C "$here" rev-list --count HEAD --not "$target" --remotes 2>/dev/null) \
        || n=$(git -C "$here" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
      [[ $n != 0 ]] && lost+=("$n commit(s) that only $here's branch has and $target drops")
      ;;
    checkout)
      # Overwrites the working tree with -f/--force, with a pathspec after --, with ".",
      # or with an argument that names an existing path (git checkout [<tree-ish>] <file>).
      pathspec=""
      for a in "${args[@]}"; do [[ $a != -* && -e $here/$a ]] && pathspec=1; done
      if [[ -n $pathspec ]] || has '^(-f|--force)$' || has '^--$' || has '^\.$'; then
        c=$(changes "$here"); [[ -n $c ]] && lost+=("uncommitted changes in $here: $c")
      fi
      ;;
    switch)
      if has '^(-f|--force|--discard-changes)$'; then
        c=$(changes "$here"); [[ -n $c ]] && lost+=("uncommitted changes in $here: $c")
      fi
      ;;
    restore)
      # Only --staged without --worktree leaves the working tree alone.
      if has '^(--staged|-[a-zA-Z]*S[a-zA-Z]*)$' && ! has '^(--worktree|-[a-zA-Z]*W[a-zA-Z]*)$'; then continue; fi
      c=$(changes "$here"); [[ -n $c ]] && lost+=("uncommitted changes in $here: $c")
      ;;
    clean)
      has '^(--force|-[a-zA-Z]*f[a-zA-Z]*)$' || continue
      has '^(--dry-run|-[a-zA-Z]*n[a-zA-Z]*)$' && continue
      if has '^-[a-zA-Z]*[xX][a-zA-Z]*$'; then
        f=$(git -C "$here" status --porcelain --ignored 2>/dev/null | sed -n 's/^\(??\|!!\) //p' | grep -Ev "$cache_re" | head -5 | tr '\n' ' ')
      else
        f=$(git -C "$here" status --porcelain 2>/dev/null | sed -n 's/^?? //p' | head -5 | tr '\n' ' ')
      fi
      [[ -n $f ]] && lost+=("files git clean deletes in $here: $f")
      ;;
  esac
done <<<"$commands"

[[ ${#lost[@]} -eq 0 ]] && exit 0
reason="worktree-guard: this would throw away local work. $(printf '%s; ' "${lost[@]}")Copy or commit it first, or confirm it is not needed. To remove a worktree, the worktree skill's wt.sh rm keeps ignored files."
jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
