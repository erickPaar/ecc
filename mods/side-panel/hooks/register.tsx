// side-panel: panes beside the transcript of the sessions you name. status: the open pull requests
// of your repositories (a Review button on each head nobody reviewed yet) and the sections your own
// command prints; aws: time left on an AWS SSO login; today: what merged today and the heads waiting
// for a first review. It reads; it sends only on a press: the review prompt, or the AWS login to the
// owner's queue. Keys 1-4 switch the tabs while a pane has the keyboard (owner-queue's is 2).
import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Asked, Aws, Board, Pull, Today } from '../types'
import { AWS_WARN, awsProfile, GH_FIELDS, MERGED_FIELDS, TABS, TODAY_FOR, key, left, lines, logins, merged, prompt, pulls, repos, seconds, ssoExpiry, ssoStartUrl, state, today } from './panel'

const PANE = 'side-panel'
const AWS_PANE = 'side-panel-aws'
const TODAY_PANE = 'side-panel-today'
const QUEUE_TOOL = 'mcp__owner-queue__ask_owner_to_run'
const aws = atom({ plugin: 'side-panel', key: 'aws' } as const, { profile: '', checked: 0 } as Aws)
const todayList = atom({ plugin: 'side-panel', key: 'today' } as const, { merged: [], read: 0 } as Today)
const board = atom({ plugin: 'side-panel', key: 'board' } as const, { pulls: [], lines: [] } as Board)
const asked = atom({ plugin: 'side-panel', key: 'asked' } as const, [] as Asked[])
const title = atom({ plugin: 'side-panel', key: 'title' } as const, '')

// Set by register; a reload runs it again.
const cfg = { sessions: '', repos: [] as string[], word: '', reviewers: [] as string[], template: '', sections: '', every: 60, profile: 'management' }
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
  await readAws($)
  await readToday($)
}

// The AWS login's expiry: the profile's SSO start URL from ~/.aws/config, then the latest token for
// it in ~/.aws/sso/cache.
async function readAws($: Engine): Promise<void> {
  const checked = await $.clock.now()
  const found: Aws = { profile: cfg.profile, checked }
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const url = ssoStartUrl(String(await $.fs.read(`${home}/.aws/config`)), cfg.profile)
    if (url === undefined) found.error = `no sso_start_url for profile ${cfg.profile}`
    else {
      const dir = `${home}/.aws/sso/cache`
      const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
      const texts: string[] = []
      for (const f of files) texts.push(String(await $.fs.read(`${dir}/${f.name}`)))
      found.expiresAt = ssoExpiry(texts, url)
      if (found.expiresAt === undefined) found.error = 'no login cached'
    }
  } catch (err) {
    found.error = err instanceof Error ? err.message.split('\n')[0] : 'unreadable'
  }
  await update($, aws, () => found)
}

// Pull requests merged today: one gh call per repository, kept TODAY_FOR.
async function readToday($: Engine): Promise<void> {
  const now = await $.clock.now()
  const kept = await read($, todayList)
  if (cfg.repos.length === 0 || (kept.read !== 0 && now - kept.read < TODAY_FOR)) return
  const { since, day } = today(now)
  const found: Today['merged'] = []
  const errors: string[] = []
  for (const repo of cfg.repos) {
    const ran = await run($, ['gh', 'pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${day}`, '--limit', '50', '--json', MERGED_FIELDS])
    if (ran.exitCode !== 0) {
      errors.push(`${repo}: ${reason(ran, 'gh failed')}`)
      continue
    }
    try {
      found.push(...merged(repo, ran.stdout, since))
    } catch {
      errors.push(`${repo}: unreadable answer from gh`)
    }
  }
  await update($, todayList, () => ({ merged: found.sort((a, b) => b.at - a.at), read: now || 1, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }))
}

// Opens the side panel's panes, status first, so the tabs read status, aws, today (and queue).
async function openPanes($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: 'status' })
  await $.ui.open({ id: AWS_PANE, title: 'aws' })
  if (cfg.repos.length > 0) await $.ui.open({ id: TODAY_PANE, title: 'today' })
}

// Shows one of this plugin's panes and gives it the keyboard.
async function show($: Engine, pane: string): Promise<void> {
  const tab = TABS.find(t => t.pane === pane)
  if (tab !== undefined) await $.ui.open({ id: pane, title: tab.name, focus: true })
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

// The row of tabs at the top of each pane: keys 1-4 while the pane has the keyboard, and Esc.
function tabs($: Engine, ui: ReturnType<Engine['ui']['resolve']>, current: string) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column">
      <Box>
        {TABS.map(t =>
          t.name === current ? (
            <Text key={`tab-${t.name}`} bold>
              {t.key}: {t.name}{'  '}
            </Text>
          ) : (
            <Button key={`tab-${t.name}`} hotkey={t.key} plain label={t.name} onPress={() => (t.pane === 'owner-queue' ? undefined : show($, t.pane))} />
          ),
        )}
      </Box>
      <Text dimColor>Ctrl+X Tab: keys here · Esc: back to the prompt</Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  cfg.sessions = (options.sessions as string) ?? ''
  cfg.repos = repos((options.repos as string) ?? '')
  cfg.word = (options.reviewed as string) ?? ''
  cfg.reviewers = logins((options.reviewers as string) ?? '')
  cfg.template = (options.review_prompt as string) ?? ''
  cfg.sections = (options.sections as string) ?? ''
  cfg.every = seconds((options.every as string) ?? '60')
  cfg.profile = awsProfile((options.aws_profile as string) ?? '')
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
      void openPanes($).catch(() => undefined)
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
    await openPanes($)
    tick($)
    return { text: '' }
  })

  // A tab key pressed in owner-queue's pane (it draws the same row) shows one of these panes.
  on('ui.press', { plugin: 'owner-queue' }, async ($, e, next) => {
    const tab = TABS.find(t => `tab-${t.name}` === e.element && t.pane !== 'owner-queue')
    if (tab !== undefined) await show($, tab.pane)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: AWS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const login = await read($, aws)
    const now = await $.clock.now()
    const isClose = login.expiresAt === undefined || login.expiresAt - now < AWS_WARN
    const command = `aws sso login --profile ${cfg.profile}`
    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs($, ui, 'aws')}
        <Box marginTop={1}>
          <Text bold>{cfg.profile}</Text>
          <Text color={isClose ? 'red' : 'green'}>
            {'  '}
            {login.expiresAt === undefined ? (login.error ?? 'not read yet') : left(login.expiresAt, now)}
            {login.expiresAt !== undefined && login.expiresAt > now ? ' left' : ''}
          </Text>
        </Box>
        {isClose && (
          <Box marginTop={1}>
            <Button
              key="aws-login"
              label="Queue login"
              hotkey="l"
              onPress={async () => {
                try {
                  await $.tool.call({ tool: QUEUE_TOOL, command, why: `AWS login for ${cfg.profile}` } as never)
                  $.ui.toast('AWS login queued')
                } catch {
                  $.ui.toast('owner-queue is not loaded')
                }
              }}
            />
            <Text dimColor> {command}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TODAY_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link } = ui
    const list = await read($, todayList)
    const waiting = (await read($, board)).pulls.filter(pull => !pull.isDraft && !pull.isReviewed)
    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs($, ui, 'today')}
        <Box marginTop={1}>
          <Text bold>Merged today</Text>
        </Box>
        {list.merged.length === 0 && <Text dimColor>none yet</Text>}
        {list.merged.map(pr => (
          <Box key={`m-${pr.repo}#${pr.number}`} flexDirection="column">
            <Text color="green" wrap="truncate-end">
              {pr.repo.split('/')[1]}#{pr.number} {pr.sha} {pr.title}
            </Text>
            <Link href={pr.url} />
          </Box>
        ))}
        <Box marginTop={1}>
          <Text bold>Waiting for a first review</Text>
        </Box>
        {waiting.length === 0 && <Text dimColor>none</Text>}
        {waiting.map(pull => (
          <Text key={`w-${key(pull)}`} color="yellow" wrap="truncate-end">
            {pull.repo.split('/')[1]}#{pull.number} {pull.sha.slice(0, 7)} {pull.title}
          </Text>
        ))}
        {list.error !== undefined && (
          <Text dimColor color="red" wrap="truncate-end">
            {list.error}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const now = await read($, board)
    const sent = await read($, asked)
    const at = await $.clock.now()
    const open = now.pulls.filter(pull => !pull.isDraft)
    const drafts = now.pulls.filter(pull => pull.isDraft)

    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs($, ui, 'status')}
        {cfg.repos.length > 0 && (
          <Box marginTop={1}>
            <Text bold>Pull requests</Text>
          </Box>
        )}
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
