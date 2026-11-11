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

// A Claude session alive on the remote machine, from its ~/.claude/sessions file.
export type RemoteSession = {
  name: string // its name, else its folder's
  cwd: string
  status?: string // busy, idle, ... where that Claude Code writes it
  kind?: string // interactive, or how it was started
  started?: number
}

// The remote machine as last read over ssh: its sessions, its subagent runs (this mod's run files
// there) and the lines its command printed, or why it could not be read.
export type Remote = {
  host: string
  read: number // when it was last asked
  sessions: RemoteSession[]
  runs: Run[]
  lines: Line[]
  error?: string // why it could not be read; shown red, in place of the rest
  note?: string // the remote command failed; shown dim
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
      remote: Remote // the other machine, read over ssh when `remote` is set
      title: string // the session's title, when the engine passes one; kept across reloads
    }
  }
}
