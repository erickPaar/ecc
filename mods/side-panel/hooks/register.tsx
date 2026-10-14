// side-panel: a pane beside the transcript of the sessions you name, with the open pull requests of
// your repositories (a Review button on each head nobody reviewed yet) and the sections your own
// command prints. It reads; the only thing it sends is the review prompt, and only on a press.
import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Asked, Board, Pull } from './panel'
import { GH_FIELDS, key, lines, logins, prompt, pulls, repos, seconds, state } from './panel'

const PANE = 'side-panel'
const board = atom({ plugin: 'side-panel', key: 'board' } as const, { pulls: [], lines: [] } as Board)
const asked = atom({ plugin: 'side-panel', key: 'asked' } as const, [] as Asked[])
const title = atom({ plugin: 'side-panel', key: 'title' } as const, '')

// Set by register; a reload runs it again.
const cfg = { sessions: '', repos: [] as string[], word: '', reviewers: [] as string[], template: '', sections: '', every: 60 }
// Your own login, read once from gh when `reviewers` is empty; and whether the refresh timer runs.
let me: string | undefined
let isTicking = false

type Ran = { exitCode: number | null; stdout: string; stderr: string } // null: never ran, or did not finish

// $.process.run rejects when the command cannot start or outlives its timeout; that is a failure too.
async function run($: Engine, argv: string[]): Promise<Ran> {
  try {
    return await $.process.run(argv)
  } catch (err) {
    return { exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function reason(ran: Ran, otherwise: string): string {
  return ran.stderr.trim().split('\n')[0] || otherwise
}

async function reviewers($: Engine, errors: string[]): Promise<string[]> {
  if (cfg.reviewers.length > 0) return cfg.reviewers
  if (me === undefined) {
    const ran = await run($, ['gh', 'api', 'user', '-q', '.login'])
    const login = ran.stdout.trim()
    if (ran.exitCode !== 0 || login === '') {
      errors.push(`reviewers: ${reason(ran, 'no login from gh')}`)
      return []
    }
    me = login
  }
  return [me]
}

async function readBoard($: Engine): Promise<void> {
  const found: Pull[] = []
  const errors: string[] = []
  const who = cfg.repos.length > 0 ? await reviewers($, errors) : []
  for (const repo of cfg.repos) {
    const ran = await run($, ['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', GH_FIELDS])
    if (ran.exitCode !== 0) {
      errors.push(`${repo}: ${reason(ran, 'gh failed')}`)
      continue
    }
    try {
      found.push(...pulls(repo, ran.stdout, cfg.word, who))
    } catch {
      errors.push(`${repo}: unreadable answer from gh`)
    }
  }
  let shown = (await read($, board)).lines
  if (cfg.sections !== '') {
    const ran = await run($, ['bash', '-c', cfg.sections])
    if (ran.exitCode === 0) shown = lines(ran.stdout)
    else errors.push(`sections: ${ran.exitCode === null ? reason(ran, 'did not run') : `exit ${ran.exitCode}`}`)
  }
  await update($, board, () => ({ pulls: found, lines: shown, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }))
}

// The session's name: its title when the engine passes one, else CZW_SESSION, which czw sets to the
// session's name when it starts claude.
async function isMine($: Engine): Promise<boolean> {
  if (cfg.sessions === '') return true
  const name = (await read($, title)) || ((await $.env.get('CZW_SESSION')) ?? '')
  try {
    return new RegExp(cfg.sessions).test(name)
  } catch {
    return false
  }
}

function tick($: Engine): void {
  if (isTicking) return
  isTicking = true
  $.clock.every(cfg.every * 1000, () => void readBoard($))
}

export const register: Register = (on, options) => {
  cfg.sessions = (options.sessions as string) ?? ''
  cfg.repos = repos((options.repos as string) ?? '')
  cfg.word = (options.reviewed as string) ?? ''
  cfg.reviewers = logins((options.reviewers as string) ?? '')
  cfg.template = (options.review_prompt as string) ?? ''
  cfg.sections = (options.sections as string) ?? ''
  cfg.every = seconds((options.every as string) ?? '60')
  me = undefined
  isTicking = false
  const hasContent = cfg.repos.length > 0 || cfg.sections !== ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Show the side panel: pull requests and your sections' })
    // CZW_SESSION reaches a headless claude -p started from this session too: only a session a
    // person is at reads and shows.
    if (e.isInteractive && hasContent && (await isMine($))) {
      tick($)
      await readBoard($)
      void $.ui.open({ id: PANE, title: 'panel' })
    }
    return next(e)
  })

  // Where the engine passes the session's title (not to a user-tier mod on every build), kept in
  // state so a reload still knows it.
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_title === 'string' && e.session_title !== '') {
      const named = e.session_title
      await update($, title, () => named)
    }
    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    await readBoard($)
    await $.ui.open({ id: PANE, title: 'panel' })
    tick($)
    return { text: '' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, board)
    const sent = await read($, asked)
    const at = await $.clock.now()
    const open = now.pulls.filter(pull => !pull.isDraft)
    const drafts = now.pulls.filter(pull => pull.isDraft)

    return (
      <Box flexDirection="column" paddingX={1}>
        {cfg.repos.length > 0 && <Text bold>Pull requests</Text>}
        {cfg.repos.length > 0 && now.pulls.length === 0 && <Text dimColor>none open</Text>}
        {[...open, ...drafts].map(pull => {
          const seen = state(pull, sent, at)
          return (
            <Box key={key(pull)} flexDirection="column">
              <Box>
                <Text color={seen === 'new' ? 'yellow' : seen === 'reviewed' ? 'green' : undefined} dimColor={pull.isDraft && seen !== 'new'}>
                  {pull.repo.split('/')[1]}#{pull.number} {pull.sha.slice(0, 7)} {seen === 'reviewed' ? '✔' : seen === 'asked' ? '…' : '●'}
                  {pull.isDraft ? ' draft' : ''}{' '}
                </Text>
                {seen === 'new' && (
                  <Button
                    key={`review-${key(pull)}`}
                    label="Review"
                    onPress={async () => {
                      const pressed = await $.clock.now()
                      await update($, asked, list => [...list.filter(a => a.key !== key(pull)), { key: key(pull), at: pressed }].slice(-200))
                      await $.prompt.submit({ text: prompt(cfg.template, pull) })
                      $.ui.toast(`Review of #${pull.number} queued`)
                    }}
                  />
                )}
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {pull.title}
              </Text>
            </Box>
          )
        })}
        {now.lines.map((line, i) =>
          line.kind === 'heading' ? (
            <Box key={`h${i}`} marginTop={1}>
              <Text bold>{line.text}</Text>
            </Box>
          ) : (
            <Text key={`l${i}`} color={line.tone} wrap="truncate-end">
              {line.text}
            </Text>
          ),
        )}
        {now.error !== undefined && (
          <Box marginTop={1}>
            <Text dimColor color="red" wrap="truncate-end">
              {now.error}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
