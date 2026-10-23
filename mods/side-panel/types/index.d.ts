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

// A pull request merged today.
export type Merged = { repo: string; number: number; title: string; url: string; sha: string; at: number }

// The AWS login the aws tab watches: when its token expires, or why that could not be read.
export type Aws = { profile: string; expiresAt?: number; error?: string; checked: number }

export type Today = { merged: Merged[]; read: number; error?: string } // read: when gh was last asked

// One subagent run, as a session wrote it to ~/.local/state/side-panel/runs/.
export type Run = {
  session: string // the name of the session that started it
  id: string // the agent's id
  label: string // its description, one line, cut short; never the prompt
  type: string // the agent type
  model?: string
  effort?: string
  isBackground: boolean
  started: number
  status: 'running' | 'done' | 'failed' | 'stopped'
  finished?: number
  beat?: number // when its session last marked it alive
}

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
      aws: Aws
      today: Today
      runs: Run[] // every session's runs, as last read
      title: string // the session's title, when the engine passes one; kept across reloads
    }
  }
}
