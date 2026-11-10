// The queue's plain logic: the marker that ticks an item when the owner runs it, which items wait on
// another, and what the pane lists. Which commands are held is guard.ts. No engine calls here, so
// tests reach it whole.

import type { Item, Kind } from '../types'

export type { Item, Kind }
export { heldReason } from './guard'

// The text Copy puts on the clipboard: the command in a subshell with pipefail, so a failure
// anywhere in a pipeline counts, then a marker that prints its exit code. The marker carries a
// nonce made at that Copy, which no tool result or message to the model holds, so a command whose
// last line the model controls cannot tick another item. A command a marker would break (a
// comment, several lines, a trailing & or ;) gets none and is ticked by hand.
export function withMarker(item: Pick<Item, 'id' | 'command'>, nonce: string): string {
  return canMark(item.command) ? `(set -o pipefail; ${item.command}); echo "oq:${item.id}:${nonce}:$?"` : item.command
}

export function canMark(command: string): boolean {
  return command !== '' && !command.includes('#') && !command.includes('\n') && !/[&;]\s*$/.test(command)
}

// The marker of a ! command's output: the last line of its standard output, and only that line,
// so a marker merely printed by the command (or quoted in a message) ticks nothing.
export function marker(row: string): { id: string; nonce: string; code: number } | undefined {
  const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(row)
  if (out === null) return undefined
  const last = (out[1] ?? '').replace(/\s+$/, '').split('\n').pop() ?? ''
  const [, id, nonce, code] = /^oq:([a-z0-9]+):([a-z0-9]+):(\d+)$/.exec(last) ?? []
  return id === undefined || nonce === undefined ? undefined : { id, nonce, code: Number(code) }
}

// Item ids and nonces are base-36 words: an id read from a file names a file in the queue folder.
export const ID = /^[a-z0-9]+$/

// Sixteen random base-36 characters, from the host's cryptographic random source.
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map(b => (b % 36).toString(36)).join('')
}

// The item already waiting for the same command (or, for a decision, the same why), so asking twice
// queues once.
export function waitingFor(items: readonly Item[], fields: Pick<Item, 'command' | 'why'>): Item | undefined {
  return items.find(one => one.status === 'waiting' && one.command === fields.command && (fields.command !== '' || one.why === fields.why))
}

// The item that must be done before this one, while it is not done yet.
export function blocker(item: Item, items: readonly Item[]): Item | undefined {
  if (item.after === undefined) return undefined
  const first = items.find(one => one.id === item.after)
  return first !== undefined && first.status !== 'done' && first.status !== 'removed' ? first : undefined
}

// The items still open, in the order asked: what waits or failed. An item's number is its place here.
export function openItems(items: readonly Item[]): Item[] {
  return items.filter(one => one.status === 'waiting' || one.status === 'failed').sort((a, b) => a.created - b.created)
}

// The item's number among the open items, from 1; undefined once it is finished.
export function numberOf(item: Item, items: readonly Item[]): number | undefined {
  const at = openItems(items).findIndex(one => one.id === item.id)
  return at < 0 ? undefined : at + 1
}

// The first item the owner can act on now: waiting (not failed) and not after an open item.
export function nextItem(items: readonly Item[]): Item | undefined {
  return openItems(items).find(one => one.status === 'waiting' && blocker(one, items) === undefined)
}

const HOUR = 3_600_000

// What the pane lists: what waits or failed, in the order asked, then what finished in the last
// hour: done, or removed by a session (who and why are shown). What the owner removed or cleared in
// the pane is not listed again, nor an item removed before 0.3.0 recorded who removed it.
export function visible(items: readonly Item[], now: number): Item[] {
  const recent = items.filter(
    one => !one.hidden && now - one.updated < HOUR && (one.status === 'done' || (one.status === 'removed' && one.by !== undefined)),
  )
  return [...openItems(items), ...recent].sort((a, b) => a.created - b.created)
}

export const KINDS = ['aws-change', 'github', 'desktop', 'local', 'decision'] as const satisfies readonly Kind[]

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

// The kind of an item when the caller names none: a decision when there is no command, else what
// the guard would hold it for, else the program it starts with.
export function kindOf(command: string, reason: string | undefined): Kind {
  if (command.trim() === '') return 'decision'
  if (reason !== undefined) {
    if (/AWS|infrastructure/.test(reason)) return 'aws-change'
    if (/push|GitHub|merge|git setting/.test(reason)) return 'github'
  }
  const first = command.trim().split(/\s+/)[0] ?? ''
  if (/^(aws|tofu|terraform|terragrunt)$/.test(first)) return 'aws-change'
  if (/^(gh|git)$/.test(first)) return 'github'
  if (first === 'rc') return 'desktop'
  return 'local'
}

export const KIND_LABEL: Record<Kind, string> = { 'aws-change': 'aws', github: 'github', desktop: 'desktop', local: 'local', decision: 'decision' }

// A command of several lines folds to its first line; `more` is how many lines are hidden.
export function fold(command: string): { head: string; more: number } {
  const lines = command.split('\n')
  return { head: lines[0] ?? '', more: lines.length - 1 }
}

// A short relative age: "now", "3 min", "2 h", "4 d".
export function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

// Who did something: the session, then the subagent of it that did.
export function who(from: string, agent: string | undefined): string {
  return agent === undefined ? from : `${from} › ${agent}`
}

// The pane's first line: how many wait and fail, and what comes next.
export function summary(items: readonly Item[]): string {
  const open = openItems(items)
  if (open.length === 0) return TEXT.empty
  const waiting = open.filter(one => one.status === 'waiting').length
  const failed = open.length - waiting
  const next = nextItem(items)
  return [
    waiting > 0 ? `${waiting} waiting` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    next !== undefined ? `next: ${(next.why || next.command).split('\n')[0]}` : undefined,
  ]
    .filter(part => part !== undefined)
    .join(' · ')
}

// What owner_queue_list answers: one block per item, open first in number order.
export function listing(items: readonly Item[], now: number, isAll: boolean): string {
  const shown = isAll ? [...items].sort((a, b) => a.created - b.created) : visible(items, now)
  if (shown.length === 0) return isAll ? 'The queue is empty.' : 'Nothing waits for the owner, and nothing finished in the last hour.'
  const next = nextItem(items)
  return shown
    .map(item => {
      const number = numberOf(item, items)
      const first = blocker(item, items)
      const head = [
        number !== undefined ? `#${number}` : '-',
        item.id,
        item === next ? 'next' : item.status,
        item.kind ?? kindOf(item.command, undefined),
        `from ${who(item.from, item.agent)}`,
        first !== undefined ? `after #${numberOf(first, items) ?? first.id} (${first.id})` : undefined,
        item.status === 'failed' ? `exit ${item.code ?? -1}` : undefined,
        `${age(now - item.created)} old`,
      ]
        .filter(part => part !== undefined)
        .join(' · ')
      const lines = [head, `  why: ${item.why}`]
      if (item.command !== '') lines.push(`  command: ${item.command}`)
      if (item.by !== undefined) lines.push(`  ${item.status} by ${item.by}${item.note ? `: ${item.note}` : ''}`)
      return lines.join('\n')
    })
    .join('\n')
}

// Files the queue no longer needs: removed or done for more than a day.
export function stale(items: readonly Item[], now: number): Item[] {
  return items.filter(one => (one.status === 'removed' || one.status === 'done') && now - one.updated > 86_400_000)
}

// The time, then four random base-36 characters: two calls in the same millisecond collide about
// once in 1.7 million, and add() still refuses an id whose file exists.
export function newId(now: number, salt: number): string {
  return now.toString(36).slice(-4) + Math.floor(salt * 36 ** 4).toString(36).padStart(4, '0')
}

export const TEXT = {
  empty: 'Nothing waits for you.',
  keys: 'c copy · d done · x remove · e expand (next item) · Esc back',
  copy: 'Copy',
  done: 'Done',
  remove: 'Remove',
  confirm: 'Remove? press again',
  more: (n: number) => `… (${n} more line${n === 1 ? '' : 's'})`,
  less: 'fold',
  expand: 'expand',
  clear: 'Clear finished',
  next: 'next',
  after: (n: number | string) => `after ${n}`,
  failed: (code: number) => `failed (exit ${code})`,
  copied: 'Copied: paste it after !',
  band: (n: number) => `${n} waiting for you · /queue`,
  held: (what: string) =>
    `owner-queue held this ${what}: only the owner runs it, with ! in a session. It is not queued. If it only reads, rewrite it so it runs: split a compound command and run the reads one per call. If the owner really must run it, call ask_owner_to_run with the command and a why; otherwise carry on without it.`,
  reads:
    "Not queued: this command only reads, so run it yourself (in the folder it needs). The owner's queue is only for what only the owner can do: AWS changes, pushes to protected branches, repository settings and decisions.",
  queued: (id: string) =>
    `Queued as ${id}. The owner sees it in the queue pane and runs it with !; it ticks itself when it exits 0. Do not paste the command into your answer again.`,
  replaced: (id: string) => `replaced by ${id}`,
  badId: (id: string) => `Not changed: ${JSON.stringify(id)} is not an item id (ids are lowercase letters and digits; owner_queue_list shows them).`,
  missing: (id: string) => `Not changed: no item ${id} in the queue.`,
  finished: (id: string, status: string) => `Not changed: ${id} is ${status} already.`,
  needsText: (what: string) => `Not changed: give a ${what}; the owner reads it in the pane.`,
  changed: (id: string, status: string) =>
    `${id} is ${status}. This only changed the pane: nothing ran and nothing was approved. Items after it are no longer blocked.`,
  failedNote: (item: { id: string; why: string; code?: number }) =>
    `owner-queue: the owner ran ${item.id} (${item.why}) and it failed with exit ${item.code ?? -1}. It stays in the queue as failed; look into it, then queue a fix with replaces: ${item.id}, or remove it with owner_queue_remove.`,
} as const
