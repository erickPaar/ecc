// side-panel: a pane beside the transcript of the sessions you name, with the open pull requests of
// your repositories (a Review button on each head nobody reviewed yet) and the sections your own
// command prints. It reads; the only thing it sends is the review prompt, and only on a press.
import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Board, Pull } from './panel'
import { GH_FIELDS, key, lines, prompt, pulls, repos, seconds, state } from './panel'

const PANE = 'side-panel'
const board = atom({ plugin: 'side-panel', key: 'board' } as const, { pulls: [], lines: [], at: 0 } as Board)
const asked = atom({ plugin: 'side-panel', key: 'asked' } as const, [] as string[])
const title = atom({ plugin: 'side-panel', key: 'title' } as const, '')
const isShown = atom({ plugin: 'side-panel', key: 'isShown' } as const, false)

// Set by register; a reload runs it again.
const cfg = { sessions: '', repos: [] as string[], word: '', template: '', sections: '', every: 60 }

async function readBoard($: Engine): Promise<void> {
  const found: Pull[] = []
  const errors: string[] = []
  for (const repo of cfg.repos) {
    const ran = await $.process.run(['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--json', GH_FIELDS])
    if (ran.exitCode !== 0) {
      errors.push(`${repo}: ${ran.stderr.trim().split('\n')[0] ?? 'gh failed'}`)
      continue
    }
    try {
      found.push(...pulls(repo, ran.stdout, cfg.word))
    } catch {
      errors.push(`${repo}: unreadable answer from gh`)
    }
  }
  let shown = (await read($, board)).lines
  if (cfg.sections !== '') {
    const ran = await $.process.run(['bash', '-c', cfg.sections])
    if (ran.exitCode === 0) shown = lines(ran.stdout)
    else errors.push(`sections: exit ${ran.exitCode}`)
  }
  const at = await $.clock.now()
  await update($, board, () => ({ pulls: found, lines: shown, at, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }))
}

async function isMine($: Engine): Promise<boolean> {
  if (cfg.sessions === '') return true
  try {
    return new RegExp(cfg.sessions).test(await read($, title))
  } catch {
    return false
  }
}

async function show($: Engine): Promise<void> {
  const placed = await $.ui.open({ id: PANE, title: 'panel' })
  await update($, isShown, () => placed.isPlaced)
}

export const register: Register = (on, options) => {
  cfg.sessions = (options.sessions as string) ?? ''
  cfg.repos = repos((options.repos as string) ?? '')
  cfg.word = (options.reviewed as string) ?? ''
  cfg.template = (options.review_prompt as string) ?? ''
  cfg.sections = (options.sections as string) ?? ''
  cfg.every = seconds((options.every as string) ?? '60')
  const hasContent = cfg.repos.length > 0 || cfg.sections !== ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Show the side panel: pull requests and your sections' })
    if (hasContent && (await isMine($))) {
      await readBoard($)
      void show($)
      $.clock.every(cfg.every * 1000, () => void readBoard($))
    }
    return next(e)
  })

  // The session's title arrives once, at start; kept in state so a reload still knows it.
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_title === 'string' && e.session_title !== '') {
      const named = e.session_title
      await update($, title, () => named)
    }
    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    await readBoard($)
    await show($)
    return { text: '' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isShown, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, board)
    const sent = await read($, asked)
    const open = now.pulls.filter(pull => !pull.isDraft)
    const drafts = now.pulls.filter(pull => pull.isDraft)

    return (
      <Box flexDirection="column" paddingX={1}>
        {cfg.repos.length > 0 && <Text bold>Pull requests</Text>}
        {cfg.repos.length > 0 && now.pulls.length === 0 && <Text dimColor>none open</Text>}
        {[...open, ...drafts].map(pull => {
          const seen = state(pull, sent)
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
                      await update($, asked, list => [...list, key(pull)].slice(-200))
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
