// The queue's plain logic: which commands are held, the marker that ticks an item when the
// owner runs it, and which items wait on another. No engine calls here, so tests reach it whole.

import type { Item } from '../types'

export type { Item }

// Each rule matches a program where a command starts (the start, a space or ;&|!) and its operation
// inside the same command (no ;&| or newline between them): `prototype/aws && git remote set-url` is
// two commands and neither is an AWS call. The lists follow ecc's prod-guard.sh, plus writes.
const IAC =
  /(^|[\s;&|!])(tofu|terraform|terragrunt)(\s+-\S+)*\s+(apply|destroy|import|taint|force-unlock|state\s+(rm|mv|push|replace-provider)|run-all\s+(apply|destroy))(\s|$)/
const AWS_DESTROY =
  /(^|[\s;&|!])aws\s([^;&|\n]*\s)?((delete|terminate|remove|deregister|purge|revoke|disable)-[a-z-]+|s3\s+(rm|rb|mv)|s3api\s+delete-[a-z-]+)(\s|$)/
// What prod-guard lets through with a question and the owner runs himself here: AWS writes.
const AWS_WRITE =
  /(^|[\s;&|!])aws\s([^;&|\n]*\s)?(put|create|update|attach|detach|associate|disassociate|modify|set|tag|untag|add|enable|start|stop|reboot|publish|send)-[a-z-]+(\s|$)/
const AWS_S3_UPLOAD =
  /(^|[\s;&|!])aws\s([^;&|\n]*\s)?s3\s+(cp|sync)\s+([^;&|\n]*\s)?s3:\/\/\S+(\s+--\S+(\s+[^-\s;&|]\S*)?)*\s*(?=$|[;&|\n])/
const MAKE_APPLY = /(^|[\s;&|!])make\s([^;&|\n]*\s)?apply(\s|$)/
const GH_MERGE = /(^|[\s;&|!])gh\s+pr\s+merge(\s|$)/
const GH_SETTINGS =
  /(^|[\s;&|!])gh\s+((secret|variable)\s+(set|delete|remove)|repo\s+(edit|delete|rename|archive|create)|ruleset\s+\S+)(\s|$)/
const GH_API_WRITE = /(^|[\s;&|!])gh\s+api\s([^;&|\n]*\s)?(-X|--method)[\s=]*(PUT|PATCH|DELETE)(\s|$)/i
const GH_API_SETTINGS_POST = /(^|[\s;&|!])gh\s+api\s([^;&|\n]*\s)?(-X|--method)[\s=]*POST(\s|$)/i
const SETTINGS_PATH = /\/(protection|rulesets|collaborators|teams|hooks|secrets|variables|environments|keys|invitations)(\/|\s|$)/

const RULES: readonly [RegExp, string][] = [
  [IAC, 'infrastructure change'],
  [AWS_DESTROY, 'destructive AWS call'],
  [AWS_WRITE, 'AWS write'],
  [AWS_S3_UPLOAD, 'upload to S3'],
  [MAKE_APPLY, 'infrastructure apply'],
  [GH_MERGE, 'pull request merge'],
  [GH_SETTINGS, 'GitHub repository settings'],
  [GH_API_WRITE, 'GitHub API write'],
]

// A heredoc is data unless a shell reads it: `python3 - <<'EOF'` or `cat > f <<EOF` hand the body to
// something that does not run commands, so its text is not checked; `bash <<EOF` and `ssh host <<EOF`
// run it, so it is. The opening line and everything outside the bodies is always checked.
const HEREDOC = /^([^\n]*?<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/gm
const SHELLS = /(^|[\s;&|(])(bash|sh|zsh|dash|ksh|ssh|eval|xargs|sudo|env|exec|source|\.)(\s|$)/

// A quoted string is an argument (a grep pattern, a commit message, a prompt) unless a shell runs it:
// `bash -c '…'`, `eval "…"`, `ssh host '…'`, `watch '…'`. Inside double quotes, `$(…)` and backticks
// still run, so they are kept.
const RUNS_QUOTE = /(^|\s)((bash|sh|zsh|dash|ksh)(\s+-\w+)*\s+-\w*c\w*|eval|watch|ssh(\s+\S+)+|xargs(\s+\S+)*|parallel(\s+\S+)*)\s*$/
const SUBSTITUTION = /\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g
// `aws <service> <operation> help` reads a manual page.
const AWS_HELP = /(^|[^\w-])aws\s[^;&|\n]*?\shelp(?=(\s+\d*>&?\S+)*\s*($|[;&|\n]))/g

function unquoted(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const quote = text[i]
    if (quote !== "'" && quote !== '"') {
      out += quote
      i += 1
      continue
    }
    let end = i + 1
    while (end < text.length && text[end] !== quote) end += quote === '"' && text[end] === '\\' ? 2 : 1
    if (end >= text.length) return out + text.slice(i) // unbalanced: keep the rest as it is
    const body = text.slice(i + 1, end)
    const before = out.slice(Math.max(out.lastIndexOf('\n'), out.lastIndexOf(';'), out.lastIndexOf('&'), out.lastIndexOf('|')) + 1)
    if (RUNS_QUOTE.test(before)) out += ` ${body} `
    else if (quote === '"') out += ` ${(body.match(SUBSTITUTION) ?? []).map(run => run.replace(/^\$\(|^`|\)$|`$/g, ' ')).join(' ; ')} `
    else out += ' '
    i = end + 1
  }
  return out
}

// The text of a command that a shell would run: heredoc bodies and quoted strings it only reads
// as data are left out, so a guard looks at commands, not at what they say.
export function shellText(command: string): string {
  const bodies = command.replace(HEREDOC, (whole, opening: string) => (SHELLS.test(opening) ? whole : opening))
  // Substitutions and subshells run their insides: `$(tofu apply)` and `(make apply)` are commands.
  return unquoted(bodies).replace(AWS_HELP, ' ').replace(/[`()]/g, ' ')
}

// Why the model may not run this command, or undefined when it may. `extra` is the person's own
// regular expression from the plugin's settings; an invalid one holds nothing more.
export function heldReason(command: string, extra = ''): string | undefined {
  const shell = shellText(command)
  for (const [rule, what] of RULES) {
    if (rule.test(shell)) return what
  }
  if (GH_API_SETTINGS_POST.test(shell) && SETTINGS_PATH.test(shell)) return 'GitHub API write'
  if (extra !== '') {
    try {
      if (new RegExp(extra).test(shell)) return 'held by your settings'
    } catch {
      return undefined
    }
  }
  return undefined
}

// The text Copy puts on the clipboard: the command, then a marker that prints its exit code.
// A command with a # could comment the marker out, so it gets none and is ticked by hand.
export function withMarker(item: Pick<Item, 'id' | 'command'>): string {
  return canMark(item.command) ? `${item.command}; echo "oq:${item.id}:$?"` : item.command
}

export function canMark(command: string): boolean {
  return command !== '' && !command.includes('#') && !command.includes('\n') && !/[&;]\s*$/.test(command)
}

// The markers in a ! command's output: which items ran, and how they ended.
export function markers(text: string): { id: string; code: number }[] {
  return [...text.matchAll(/oq:([a-z0-9]+):(\d+)/g)].map(m => ({ id: m[1], code: Number(m[2]) }))
}

// The item that must be done before this one, while it is not done yet.
export function blocker(item: Item, items: readonly Item[]): Item | undefined {
  if (item.after === undefined) return undefined
  const first = items.find(one => one.id === item.after)
  return first !== undefined && first.status !== 'done' && first.status !== 'removed' ? first : undefined
}

// What the pane lists: what waits or failed, in the order asked, then what finished in the last hour.
export function visible(items: readonly Item[], now: number): Item[] {
  const open = items.filter(one => one.status === 'waiting' || one.status === 'failed')
  const recent = items.filter(one => one.status === 'done' && now - one.updated < 3_600_000)
  return [...open, ...recent].sort((a, b) => a.created - b.created)
}

export function newId(now: number, salt: number): string {
  return (now.toString(36) + Math.floor(salt * 1296).toString(36)).slice(-6)
}

export const TEXT = {
  title: (n: number) => `Waiting for you · ${n}`,
  empty: 'Nothing waits for you.',
  copy: 'Copy',
  done: 'Done',
  remove: 'Remove',
  clear: 'Clear finished',
  after: (n: number) => `after ${n}`,
  failed: (code: number) => `failed (exit ${code})`,
  copied: 'Copied: paste it after !',
  band: (n: number) => `${n} waiting for you · /queue`,
  held: (what: string, id: string) =>
    `owner-queue held this ${what}: only the owner runs it, with ! in a session. It is in the owner's queue as ${id}; tell the owner why it is needed, and carry on with what does not depend on it.`,
  queued: (id: string) =>
    `Queued as ${id}. The owner sees it in the queue pane and runs it with !; it ticks itself when it exits 0. Do not paste the command into your answer again.`,
} as const
