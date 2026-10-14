// The queue's plain logic: the marker that ticks an item when the owner runs it, which items wait on
// another, and what the pane lists. Which commands are held is guard.ts. No engine calls here, so
// tests reach it whole.

import type { Item } from '../types'

export type { Item }
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

// What the pane lists: what waits or failed, in the order asked, then what finished in the last hour.
export function visible(items: readonly Item[], now: number): Item[] {
  const open = items.filter(one => one.status === 'waiting' || one.status === 'failed')
  const recent = items.filter(one => one.status === 'done' && now - one.updated < 3_600_000)
  return [...open, ...recent].sort((a, b) => a.created - b.created)
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
