---
name: worktree
description: Create, remove and list git worktrees without losing work, inside each repository at <repo>/.claude/worktrees/<name>. Use whenever a task needs a separate checkout (a new branch, a review, a parallel session), before removing or cleaning up any worktree, and for a periodic cleanup ("which worktrees are left?").
argument-hint: "add <name> [branch] [base] | rm <name> | list"
---

# Worktrees

Every worktree goes inside its own repository, at `<repo>/.claude/worktrees/<name>`, never beside it. Run each step through the script in this skill's folder, from inside the repository: `bash <this skill's folder>/scripts/wt.sh <add|rm|list> ...`.

- `add <name> [branch] [base]` makes the worktree on a new branch, from the remote's default branch unless you give a base. A branch that exists only on the remote (a pull request to review) is tracked instead. It also adds `.claude/worktrees/` to the repository's `.git/info/exclude`, so git never shows or commits it.
- `rm <name> [--keep-branch]` removes one worktree and its local branch, once nothing would be lost. It refuses when:
  - there are uncommitted changes;
  - there are commits on no remote;
  - a process or a compose project is running inside the worktree.

  The process check reads `/proc`, so on macOS only containers are detected.

  Ignored files that are not caches (`.env`, local data) are copied to `.claude/worktrees/.removed/` and checked before the remove.
- `list [repo...]` shows each worktree with its branch, size, uncommitted changes and pull request (when `gh` is installed). With no argument it lists the current repository, or every repository under the folders in `WT_ROOTS` (colon-separated).

The plugin's `worktree-guard` hook backs this up. A bare `git worktree remove`, `git reset --hard`, `git checkout -- <path>`, `git checkout -f`, `git switch --discard-changes`, `git restore` or `git clean -f` that would throw away local work asks the user first and names what would be lost.

## Rules

- **The branch or the worktree already exists.** Stop and look (`list`, `git log <branch>`), and ask whose it is. If it isn't clearly yours, make a new one under another name. Never `reset --hard`, `checkout --` or `switch` over work you didn't make: it can be another session's uncommitted change.
- **Removing.** Always through `rm`, never a bare `git worktree remove` or `rm -rf`. `git worktree remove` deletes the files git ignores, and a `.env` or a local database lives there.
- **Commits on no remote.** After a squash merge, a branch's commits never reach the default branch under their own ids. Before calling them lost or safe, check whether their content is there: grep for what they added, or ask. Never decide from the commit ids alone.
- **Something runs from the worktree.** A dev server, a container or another session. Stop it first, or leave the worktree alone.
- **Scratch files.** Logs, review notes and throwaway scripts go in the session's scratch folder, not in a repository or in the folder that holds them. Delete review clones when the review is done.

## Cleanup

1. Run `list`.
2. A worktree whose pull request is merged, with no changes: `rm` it.
3. An open pull request, or none at all: leave it, and tell the user which session or person seems to own it.
4. Anything in `.claude/worktrees/.removed/`: list it for the user, never delete it yourself.
