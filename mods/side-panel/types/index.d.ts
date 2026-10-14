// The values side-panel keeps for the session.
export type Pull = {
  repo: string
  number: number
  sha: string // the head, full
  title: string
  isDraft: boolean
  isReviewed: boolean // a reviewer's comment or review names this head (and the review word, when one is set)
}

export type Line = { kind: 'heading' | 'text'; text: string; tone?: 'red' | 'green' | 'blue' }

export type Asked = { key: string; at: number } // a head queued from the pane (repo#number@sha), and when

export type Board = {
  pulls: Pull[]
  lines: Line[]
  error?: string // why the last read failed, shown dim
}

declare module 'claude-code' {
  interface PluginState {
    'side-panel': {
      board: Board
      asked: Asked[] // heads whose review was queued from the pane
      title: string // the session's title, when the engine passes one; kept across reloads
    }
  }
}
