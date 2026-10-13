// The values side-panel keeps for the session.
export type Pull = {
  repo: string
  number: number
  sha: string // the head, full
  title: string
  isDraft: boolean
  isReviewed: boolean // a comment names this head (and the review word, when one is set)
}

export type Line = { kind: 'heading' | 'text'; text: string; tone?: 'red' | 'green' | 'blue' }

export type Board = {
  pulls: Pull[]
  lines: Line[]
  at: number // when it was read
  error?: string // why the last read failed, shown dim
}

declare module 'claude-code' {
  interface PluginState {
    'side-panel': {
      board: Board
      asked: string[] // heads whose review was queued from the pane: repo#number@sha
      title: string // the session's title, kept across reloads
      isShown: boolean
    }
  }
}
