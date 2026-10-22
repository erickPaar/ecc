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

- **One queue, in a pane beside the transcript of every session.** Each item shows why, which session asked and the whole command, with **Copy**, **Done** and **Remove** (a decision with no command has no Copy). An item that must wait for another says `after N` and has no buttons until that one is done. With the pane closed, one line above the prompt says how many wait; `/queue` opens it.
- **Sessions add to it** with the `ask_owner_to_run` tool instead of writing commands in their answer. Asking again for a command that already waits answers with the same item.
- **Who asked:** the session's title when the engine passes it, else `CZW_SESSION` (the name czw gives each session it starts), else the folder's name. On this build the event that carries the title does not reach a mod installed at user level, so in practice it is `CZW_SESSION` or the folder.
- **The guard** checks every tool call that carries a shell command (Bash, Monitor and any other), and refuses, from the model, what follows. Each refused command goes into the queue. It is a best effort, not an integrity boundary (see what it does not see, below).
  - **Infrastructure:** `tofu`, `terraform` and `terragrunt` apply, destroy, import, taint, untaint, force-unlock, refresh, state edits and `workspace delete`, terragrunt's `apply-all`/`destroy-all` and `run-all`/`run --all`/`stack run` with a write; `make apply`, `make destroy` and `make import`. `-help`/`--help` and `make -n`/`--dry-run`/`--just-print` pass.
  - **AWS:** every call except reads. Reads are operations named `get-`, `list-`, `describe-`, `head-` and the like, plus `query`, `scan`, `wait`, a few named reads (`logs start-query`, `athena start-query-execution`…) and `eks update-kubeconfig` (it writes only your kubeconfig), `sts`, `sso`, `configure` and model calls (`bedrock-runtime`). `help` passes as the service, the operation or the word right after the operation; anywhere else it may be an option's value (`--names p1 help` deletes `help` too), so it is held. In `s3`: `ls`, `presign`, and `cp`/`sync` from S3 to here; any S3 path after the first positional is an upload.
  - **GitHub:** `gh workflow run|enable`, `gh run rerun`, `gh secret|variable set|delete`, `gh repo create|edit|delete|rename|archive`, `gh repo deploy-key add|delete`, and `gh api` writes. Options between the group and the verb (`gh secret --env prod set`) are read. A `gh api` call counts as a write with `-X`/`--method` PUT, PATCH or DELETE (attached forms too), or with fields and no method (an implicit POST: `-f`, `-F`, `-fKEY=V`, `--field=`, `--raw-field=`, `--input`) when it reaches settings, statuses, check runs, deployments, dispatches, reruns, deployment approvals or a transfer; GraphQL mutations count, and so does a query read from a file or computed (`query="$(cat q.graphql)"`, `query="$Q"`). Comments, deleting a comment, edits to a pull request's or issue's body, and merges pass. `--help` passes.
  - **Git and plugins:** pushes to `main`/`master` (as a refspec's destination: `main`, `heads/main`, `refs/heads/main`), `--all`, `--branches`, `--mirror`, and refspecs that push many branches (`:`, `refs/heads/*`), which run what the default branch applies. A refspec computed from a variable or a substitution (`$BRANCH`, `$(cat f)`) is held, except a substitution that prints the current branch (`$(git branch --show-current)`, `$(git rev-parse --abbrev-ref HEAD)`). A push with no refspec, or of `HEAD`, `@` or that substitution, pushes the current branch: the guard reads it with `git -C <folder> rev-parse --abbrev-ref HEAD`, in the session's folder, the `-C` folder and every folder a `cd` or `pushd` before it names, and holds the push when that is `main`/`master` or when git cannot say. A `git checkout` or `git switch` earlier in the same command changes that branch: a switch or a new branch (`-b`, `-c`) is the branch pushed; a checkout of one word (a branch or a file) adds it to what the branch may be; a switch it cannot name (`-`, `--detach`, a variable) holds the push. A push run in a folder the guard cannot name (`env -C`, `sudo -D`, `GIT_DIR=`, `GIT_WORK_TREE=`, `--git-dir`, `--work-tree`) is held. `claude plugin(s) disable|uninstall` and `claude plugin marketplace remove`.

  The guard reads the command the way a shell would. It splits it into the simple commands it runs, with quotes, line continuations (an odd number of backslashes before the newline), paths (`/usr/local/bin/tofu`), keywords (`if`, `elif`, `while`, `until`, `then`, `do`, `!`, `{`, `coproc`, `function NAME`) and wrappers taken off, wrappers' value options included: `env` (`-u`, `-C`, `-S`), `sudo`, `doas`, `timeout`, `nice`, `ionice`, `chrt`, `taskset`, `stdbuf`, `nohup`, `time`, `exec -a`, `command`, `caffeinate`, `flock`, `su -c`, `direnv exec`, `aws-vault exec`. It also opens what runs inside: `$(…)`, backticks, subshells, `bash -c` (with its options before the command), `eval`, `ssh host …`, `watch`, `xargs` (with what it reads from a pipe), `script -c`, `find -exec`, `docker`/`podman run|exec`, `docker compose run|exec`, `kubectl exec … --`, heredocs, here-strings and pipes read by a shell (`echo '…' | bash`, `bash <<< '…'`), and substitutions in unquoted heredocs. When a later word of a command is exactly `tofu`, `terraform`, `terragrunt`, `aws`, `gh` or `git` (or a path in a `bin` folder), the guard judges again from there, for wrappers it does not know; programs that only print or test their words (`echo`, `which`, `grep`…) are not read so. Arguments that are only text, like a grep pattern, a commit message or a heredoc fed to python, are not commands. A heredoc inside a substitution (`"$(cat <<'EOF' … EOF)"`, the usual commit or pull request body) is data, whatever brackets or quotes it holds. A command the guard cannot read to its end (a quote, a `$(` or a backtick left open, which bash refuses too) is held, as is a command nested too deeply to read, and anything when the guard itself fails. Your own `!` commands never reach it.
- **The tick:** Copy makes a nonce, keeps it in the item, and puts `(set -o pipefail; <command>); echo "oq:<id>:<nonce>:$?"` on the clipboard. When you run it with `!`, the item turns ✓ on exit 0 and ✗ with the exit code otherwise, a failure anywhere in a pipeline included. Only the last line of your own `!` output counts, and only with the nonce of the item's last Copy: a peer session, a plugin, a typed prompt or the model never tick an item, and neither does a queued command that prints another item's marker. The `!` row that carries the command spends the nonce (the model sees that row): from then on only that run's own output can tick the item, so a run that leaves no marker (killed, its output cut short) leaves the item for **Done**, and a marker printed later ticks nothing. A tick spends the nonce too. A command a marker would break (a comment, several lines, a trailing `&` or `;`) is copied as is and ticked with **Done**.

The queue is a folder of JSON files, one per item, shared by every session on the machine (`~/.local/state/owner-queue`). An item whose id is not a plain lowercase word is ignored. Items finished or removed more than a day ago are deleted. The folder is not an integrity boundary: anything that can write files there can add or tick an item, and anything that can read them can read a nonce.

```
/plugin install owner-queue@erick
```

| Setting | Effect |
|---------|--------|
| `pane` | `auto` opens the pane when something waits; `command` only with `/queue`; `off` never (the line above the prompt stays) |
| `held` | a regular expression of further commands to hold, added to the built-in list. It is tested against each simple command as written, with quotes and wrappers taken off and words joined by spaces, so it does not catch other spellings of the same thing (`gh api -X PUT …/merge` for `gh pr merge`). Merges pass by default, and `gh\s+pr\s+merge` holds them |
| `dir` | the queue folder (default `~/.local/state/owner-queue`) |

The guard is a best effort: it catches the ways a model writes a command by accident, not deliberate evasion. It does not see:
- a command written to a script file and run from it;
- a program name held in a variable (`$TF apply`), or a command built in a variable and run with `eval "$CMD"`;
- brace expansion (`{tofu,} apply`) and other expansions that build a program's name;
- another case of a program's name on a case-insensitive file system (`TOFU apply` on macOS);
- calls made from code (`python -c` with boto3, an SDK);
- a nested `claude -p` that runs its own tools;
- a push from a folder the shell moved to in an earlier tool call (it reads the branch in the session's folder), or a branch whose upstream is `main` pushed with `push.default=upstream`;
- a branch switched by another program (`gh pr checkout`, `git rebase <base> <branch>`), or a `git switch` that fails before a push joined to it with `;`;
- tools other than shell commands.

It also holds some commands that are harmless: a push of a loop's variable (`for b in …; do git push origin $b; done`), whatever branches the list names.

The clipboard keeps the last copied command, marker and nonce included, until something else is copied: anything that can read your clipboard can read a nonce.

If the engine shortens a long `!` output and drops its last line, the marker is lost and the item does not tick: press **Done**.

The account's permissions are the control; the guard doesn't replace them. ecc's prod guard (above) is separate and narrower. It asks before infrastructure applies, destroys and state edits, and before AWS deletions, on Bash only. It does not cover AWS writes, uploads, GitHub settings or workflows.

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
