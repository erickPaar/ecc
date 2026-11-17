// The Running section's plain logic: one JSON file per run, written by every session that loads the
// mod, read by the panel. A run carries its label only (cut short), never its prompt.

import type { Run } from '../types'

export type { Run }

// How often a session marks its running runs alive, and when a run whose session stopped doing so
// shows as stale rather than running.
export const BEAT_EVERY = 30_000
export const STALE_AFTER = 3 * 60_000
// When a stale run stops showing (its file is still deleted only after a day).
export const STALE_SHOWN_FOR = 6 * 60 * 60_000
// How long a finished run shows, and when its file is deleted.
export const SHOWN_FOR = 60 * 60_000
export const KEPT_FOR = 24 * 60 * 60_000

const LABEL_MAX = 60

// One line, at most LABEL_MAX characters.
export function label(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one
}

// A file name made of the session's name and the run's id, letters, digits, `.`, `_` and `-` only.
export function fileName(session: string, id: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 80) || '_'
  return `${safe(session)}--${safe(id)}.json`
}

// A run file's text, or undefined when it is not one (another writer's half file, say).
export function parse(text: string): Run | undefined {
  try {
    const run = JSON.parse(text) as Run
    return typeof run.id === 'string' && typeof run.session === 'string' && typeof run.started === 'number' ? run : undefined
  } catch {
    return undefined
  }
}

// The agent list's status as a run's.
export function fromAgent(status: string): Run['status'] | undefined {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  return undefined
}

// How a running run ends by what the agent list says of its agent. An agent that is idle has
// finished its turn and waits for a message that may never come: its work is done (a teammate
// idles between tasks and keeps running).
export function endedBy(status: string, type: string): Run['status'] | undefined {
  if (status === 'idle' && type !== 'teammate') return 'done'
  return fromAgent(status)
}

// How a run ends when the agent list no longer holds its agent and nothing else said how: stopped,
// outcome unknown. A workflow's agents never send a stop event and are dropped from the list once they
// finish, so theirs is taken as done, not as stopped.
export function endedUnseen(type: string): Run['status'] {
  return type === 'workflow-subagent' ? 'done' : 'stopped'
}

// How many runs ended otherwise than running or failed, as "2 done · 1 stopped".
export function settledCounts(runs: readonly Run[]): string {
  const done = runs.filter(r => r.status === 'done').length
  const stopped = runs.filter(r => r.status === 'stopped').length
  return [done > 0 ? `${done} done` : undefined, stopped > 0 ? `${stopped} stopped` : undefined].filter(part => part !== undefined).join(' · ')
}

// Whether a run file is old enough to delete: finished, or last marked alive, a day ago.
export function isOld(run: Run, now: number): boolean {
  return now - (run.finished ?? run.beat ?? run.started) > KEPT_FOR
}

export type Shown = Run & { isStale: boolean }

// What the section shows, by session (sessions in name order): running first, oldest first, then the
// runs finished in the last hour, newest first. A running run whose session has not marked it alive
// for STALE_AFTER is stale.
export function sections(runs: readonly Run[], now: number): { session: string; runs: Shown[] }[] {
  const by = new Map<string, Shown[]>()
  for (const run of runs) {
    const silent = now - (run.beat ?? run.started)
    const isStale = run.status === 'running' && silent > STALE_AFTER
    if (isStale && silent > STALE_SHOWN_FOR) continue
    if (run.status !== 'running' && now - (run.finished ?? run.started) > SHOWN_FOR) continue
    by.set(run.session, [...(by.get(run.session) ?? []), { ...run, isStale }])
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([session, list]) => ({
      session,
      runs: [
        ...list.filter(r => r.status === 'running').sort((a, b) => a.started - b.started),
        ...list.filter(r => r.status !== 'running').sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0)),
      ],
    }))
}

// The kinds of work the Running section groups runs by, in the order it shows them. A run's kind is told from
// its agent type and its label (the description its session gave): a label that starts with a building verb
// ("Fix review findings", "Add tests") is a build whatever follows; otherwise the first kind whose words match
// wins, reviews before checks before builds before research. Words are whole (\b on both sides).
export const CATEGORY_ORDER = ['Reviews', 'Builds', 'Checks', 'Research'] as const

const LEADS_A_BUILD = /^\W*(fix|address|apply|implement|add|build|write|port|refactor)\b/i
const KINDS: readonly { name: (typeof CATEGORY_ORDER)[number]; type?: RegExp; label: RegExp }[] = [
  { name: 'Reviews', type: /review|verif/i, label: /\b(review|reviews|revisão|delta|re-?check|verify|audit|grade)\b/i },
  { name: 'Checks', label: /\b(mutation|mutate|make check|ci|lint|tests?|benchmark|evals?)\b/i },
  { name: 'Builds', type: /build|implement|resolver/i, label: /\b(build|implement|step \d+|feat|fix|write|add|port|refactor|draft)\b/i },
  { name: 'Research', type: /explore|plan|guide|fetch|research/i, label: /\b(search|find|survey|list|scan|map|read|investigate|research|compare|assess)\b/i },
]

export function category(run: Pick<Run, 'type' | 'label'>): string {
  if (LEADS_A_BUILD.test(run.label)) return 'Builds'
  return KINDS.find(k => k.type?.test(run.type) || k.label.test(run.label))?.name ?? 'Other'
}

export type Category = { name: string; running: Shown[]; failed: Shown[]; done: number; stopped: number; stale: number }

// What the section shows, by kind of work (the order of CATEGORY_ORDER, then Other; empty kinds left out): the
// running runs, oldest first, and the failed ones of the last hour, each on its line; the runs done or
// stopped in the last hour only as counts. Visibility follows sections(): stale after STALE_AFTER, finished
// shown for SHOWN_FOR.
export function categories(runs: readonly Run[], now: number): Category[] {
  const by = new Map<string, Category>()
  for (const run of sections(runs, now).flatMap(s => s.runs)) {
    const name = category(run)
    const c = by.get(name) ?? { name, running: [], failed: [], done: 0, stopped: 0, stale: 0 }
    if (run.status === 'running') {
      c.running.push(run)
      if (run.isStale) c.stale++
    }
    else if (run.status === 'failed') c.failed.push(run)
    else if (run.status === 'done') c.done++
    else c.stopped++
    by.set(name, c)
  }
  const order = [...CATEGORY_ORDER, 'Other']
  return order.flatMap(name => {
    const c = by.get(name)
    if (!c) return []
    c.running.sort((a, b) => a.started - b.started)
    return [c]
  })
}

// 45s, 12m, 1h 05m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
