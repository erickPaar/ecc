# ecc

A Claude Code-only cut of [ECC](https://github.com/affaan-m/ECC): the pieces worth
having, plus three guards, a skill and a snapshot hook of its own. ECC's full install brings 361 skills and agents
(about 26k tokens of descriptions in every session) and 24 hooks; this keeps the
parts that earn their place.

| Piece | What it does | Source |
|-------|--------------|--------|
| prod guard | `tofu`/`terraform`/`terragrunt` apply, destroy, import and state edits, and AWS `delete-*`/`terminate-*`/`s3 rm` calls always ask you, even in auto mode, naming the AWS profile in use | own |
| suppression guard | an edit that adds `# noqa`, `# type: ignore`, `# pyrefly: ignore`, `//nolint`, Dart `// ignore:`, `# tflint-ignore` and the like, or loosens a ruff/pyrefly/import-linter/golangci/`analysis_options`/tflint config, asks you first; moving or removing suppressions never does | own |
| worktree guard | a `git worktree remove`, `git reset --hard`, `git checkout -- <path>`, `git restore` or `git clean -f` that would throw away local work asks you first and names it: uncommitted changes, commits on no remote, and the ignored files (`.env`, local data) that `worktree remove` deletes too; caches don't count, and with nothing to lose the command passes. Stashes are out of scope: `git stash drop` and `clear` pass | own |
| worktree | skill and script: worktrees inside each repository at `.claude/worktrees/<name>`, kept out of git through `.git/info/exclude`; `add` refuses a name or branch that exists, `rm` refuses changes, commits on no remote and a worktree something runs from, and copies ignored files out before removing; `list` shows branch, size, changes, pull request and the worklog's status and next; each worktree gets a worklog beside it (plan, verification, invariants, surprises, status), never committed; `rm` recognises a squash-merged branch | own |
| wip snapshot | when a session ends (or is cleared) with uncommitted changes to files it edited in a worktree, saves them as a patch in `.claude/worktrees/.wip/` and writes the restore command in the worklog. It reads git only through plumbing: it never refreshes or locks the index and ignores your diff settings | own |
| GateGuard | before a destructive shell command (`rm -rf`, force push to main, `DROP TABLE`…) Claude must list what it touches, a rollback step and your instruction, then retry | ECC |
| strategic compact | suggests `/compact` at natural breakpoints instead of letting auto-compaction hit mid-task | ECC |
| verification loop | skill: build, types, lint, tests and a diff review before calling work done | ECC |
| save / resume session | `/ecc:save-session` writes where you left off; `/ecc:resume-session` picks it up | ECC |
| learn-eval | `/ecc:learn-eval` after solving something non-trivial: extracts the reusable lesson, checks it's worth keeping, saves it as a global or project skill with your approval | ECC |
| silent-failure-hunter | agent that reviews for swallowed errors, bad fallbacks and lost error propagation (Python `except`, Go `_ = err`) | ECC |
| fix-defect | skill: reproduce the bug as a failing regression test, root cause, smallest fix, verify with the repo's own checks, review with the repo's own standards, commit after you confirm. The idea of ECC's `orch-fix-defect`, without its pipeline of ECC agents | own |
| santa-method | skill: two independent reviewers with the same rubric must both pass before something ships; for high-stakes changes | ECC |
| Flutter | `flutter-reviewer` and `dart-build-resolver` agents, `/ecc:flutter-review`, `/ecc:flutter-build`, `/ecc:flutter-test`, the `dart-flutter-patterns` skill and an `accessibility` (WCAG 2.2, iOS/Android) skill | ECC |

GateGuard runs on Bash only. Its edit gate (facts before the first edit of each
file) and its once-per-session routine-command gate are left off: too much friction
in auto mode.

## Install

The plugin is `ecc@erick`, so it can't be confused with upstream's `ecc@ecc`. Don't
install both: their `/ecc:` commands would collide.

```
/plugin marketplace add erickPaar/ecc
/plugin install ecc@erick
```

The ECC hooks need Node 18+. `bin/node-run` uses the first of `$ECC_NODE`,
`node` on PATH, `~/.local/share/node22` or the newest nvm Node; with none it skips
the hook with a warning rather than blocking every call.

## Configure

| Variable | Effect |
|----------|--------|
| `ECC_SAFE_PROFILES` | comma-separated AWS profiles the prod guard lets through without asking, e.g. `dev` |
| `GATEGUARD_BASH_EXTRA_DESTRUCTIVE` | extra regex GateGuard treats as destructive |
| `GATEGUARD_DISABLED=1` | turn GateGuard off |
| `ECC_WIP_SNAPSHOT=0` | turn the end-of-session snapshot off |
| `WT_CACHE_RE` | extra regex of ignored paths that the worktree guard and `wt.sh rm` treat as caches, safe to lose |
| `WT_OWNER` | the owner `wt.sh add` writes in a new worklog (default: `git config user.name`); a session can set its own name |
| `WT_ROOTS` | colon-separated folders whose repositories `wt.sh list` shows when run outside a repository |

Set them in `~/.claude/settings.json` under `env`, or per repository in `.claude/settings.json`.

## owner-queue (a mod)

A second plugin in this marketplace, `owner-queue@erick`: a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (2.1.287+) for a person who runs several sessions and keeps some commands for themselves.

- **One queue, in a pane beside the transcript of every session.** Each item shows why, which session asked and the command, with **Copy** and **Remove**. An item that must wait for another says `after N` and has no Copy until that one is done. With the pane closed, one line above the prompt says how many wait; `/queue` opens it.
- **Sessions add to it** with the `ask_owner_to_run` tool instead of writing commands in their answer.
- **The guard** refuses, from the model, infrastructure applies and destroys, AWS writes and deletes, uploads to S3, `make apply`, GitHub secrets, variables and repository settings, and GitHub API writes. Each refused command goes into the queue. Reads pass. It checks what a shell would run: heredoc bodies and quoted strings handed to programs that run no commands are data, while `bash -c '…'`, `eval`, `ssh host '…'`, `$(…)` and backticks are checked. If the guard itself fails, it refuses. Your own `!` commands never reach it.
- **The tick:** Copy adds `; echo "oq:<id>:$?"` to the command. When you run it with `!`, the item turns ✓ on exit 0 and ✗ with the exit code otherwise. Only your own `!` output counts.

The queue is a folder of JSON files, one per item, shared by every session on the machine (`~/.local/state/owner-queue`).

```
/plugin install owner-queue@erick
```

| Setting | Effect |
|---------|--------|
| `pane` | `auto` opens the pane when something waits; `command` only with `/queue`; `off` never (the line above the prompt stays) |
| `held` | a regular expression of further commands to hold, added to the built-in list; merges pass by default, and `gh\s+pr\s+merge` holds them |
| `dir` | the queue folder (default `~/.local/state/owner-queue`) |

The guard is a best effort on the command's text. A command written to a script file and run from it is not seen, so it doesn't replace account permissions. The prod guard above still asks for anything owner-queue lets through.

## Upstream

`upstream.lock` records, for each imported file, the ECC commit it came from and its
checksum at import, so upstream changes and local edits can be told apart:

```
scripts/sync-upstream                 # status of every imported file
scripts/sync-upstream diff <path>     # what upstream changed since the import
scripts/sync-upstream take <path>     # take upstream's version (refuses over local edits)
scripts/sync-upstream add <path>...   # import more files from ECC
```

Imported files keep their upstream paths (`agents/`, `commands/`, `skills/`, `scripts/`) so their `require()`s resolve unchanged.

## Test

```
tests/run.sh       # every hook and script case, and the mods' own tests (claude plugin test)
tests/mutate.sh    # break each guard in tests/mutations.json once; prints which a test catches
```
