// The values owner-queue keeps for the session. Item is also the shape of each queue file.
export type Status = 'waiting' | 'done' | 'failed' | 'removed'

// What kind of thing the owner is asked for: the pane labels each item with it.
export type Kind = 'aws-change' | 'github' | 'desktop' | 'local' | 'decision'

export type Item = {
  id: string
  command: string // empty for a decision that has no command ("approve the release")
  why: string
  from: string // the session that asked
  agent?: string // the subagent of that session that asked: its description, else its type, else its id
  after?: string // the id of the item that must be done first
  kind?: Kind // absent on items queued before 0.3.0
  session?: string // the engine's id of the session that asked: it gets a note when the item fails
  status: Status
  code?: number // the exit code the marker reported
  by?: string // who removed it or marked it done: a session (› its subagent), or "owner" from the pane
  note?: string // why it was removed, or how it was verified done
  hidden?: boolean // the owner removed or cleared it in the pane: not listed again
  noted?: boolean // the asking session has been told it failed
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
      confirm: string // the id whose Remove waits for a second press, else ''
      expanded: string[] // the ids whose folded command the pane shows whole
    }
  }
}
