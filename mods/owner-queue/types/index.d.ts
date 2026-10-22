// The values owner-queue keeps for the session. Item is also the shape of each queue file.
export type Status = 'waiting' | 'done' | 'failed' | 'removed'

export type Item = {
  id: string
  command: string // empty for a decision that has no command ("approve the release")
  why: string
  from: string // the session that asked
  after?: string // the id of the item that must be done first
  status: Status
  code?: number // the exit code the marker reported
  nonce?: string // made at the last Copy, spent by the tick; only a marker carrying it ticks
  running?: string // the nonce of a ! run that started: only that run's own output can tick it
  created: number
  updated: number
}

declare module 'claude-code' {
  interface PluginState {
    'owner-queue': {
      items: Item[]
      isPaneShown: boolean
      title: string // the session's title, kept across reloads (the event that carries it fires once)
    }
  }
}
