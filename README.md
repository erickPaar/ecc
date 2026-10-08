# ecc

A Claude Code-only cut of [ECC](https://github.com/affaan-m/ECC): the pieces worth
having, plus two guards of its own. ECC's full install brings 361 skills and agents
(about 26k tokens of descriptions in every session) and 24 hooks; this keeps the
parts that earn their place.

| Piece | What it does | Source |
|-------|--------------|--------|
| prod guard | `tofu`/`terraform`/`terragrunt` apply, destroy, import and state edits, and AWS `delete-*`/`terminate-*`/`s3 rm` calls always ask you, even in auto mode, naming the AWS profile in use | own |
| suppression guard | an edit that adds `# noqa`, `# type: ignore`, `# pyrefly: ignore`, `//nolint`, Dart `// ignore:`, `# tflint-ignore` and the like, or loosens a ruff/pyrefly/import-linter/golangci/`analysis_options`/tflint config, asks you first; moving or removing suppressions never does | own |
| GateGuard | before a destructive shell command (`rm -rf`, force push to main, `DROP TABLE`…) Claude must list what it touches, a rollback step and your instruction, then retry | ECC |
| strategic compact | suggests `/compact` at natural breakpoints instead of letting auto-compaction hit mid-task | ECC |
| verification loop | skill: build, types, lint, tests and a diff review before calling work done | ECC |
| save / resume session | `/ecc:save-session` writes where you left off; `/ecc:resume-session` picks it up | ECC |
| learn-eval | `/ecc:learn-eval` after solving something non-trivial: extracts the reusable lesson, checks it's worth keeping, saves it as a global or project skill with your approval | ECC |
| silent-failure-hunter | agent that reviews for swallowed errors, bad fallbacks and lost error propagation (Python `except`, Go `_ = err`) | ECC |
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

Set them in `~/.claude/settings.json` under `env`, or per repository in `.claude/settings.json`.

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
tests/run.sh
```
