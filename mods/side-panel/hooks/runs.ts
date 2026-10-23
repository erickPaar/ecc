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

// 45s, 12m, 1h 05m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
