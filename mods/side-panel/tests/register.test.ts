import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SHA = 'b5687a5e1c0d2f3a4b5c6d7e8f9a0b1c2d3e4f5a'
const OPTIONS = { sessions: 'coordinator', repos: 'o/api', reviewed: 'Verdict', reviewers: 'alice', sections: 'print-sections', review_prompt: 'Review {repo}#{number} at {sha}' }
const PANE = { component: 'Pane', requestId: 'side-panel', surface: 'terminal', props: {} } as never

type World = {
  comments?: { body: string; author?: { login: string } }[]
  list?: object[] // what gh pr list answers, in place of one pull request with `comments`
  down?: string[] // repositories gh fails for, with `stderr`
  stderr?: string
  rejects?: 'gh' | 'sections' // a command that cannot start or times out
  sectionsExit?: number
  ghJson?: string // gh pr list's raw answer
  login?: string | null // what `gh api user` answers; null fails
  czw?: string // CZW_SESSION
}

// What a session answers beneath the plugin: gh, the sections command, the environment and the
// start-up calls. `order` notes the reads and the pane's opening, in turn.
function world(on: On, w: World = {}) {
  const ran: string[][] = []
  const opened: string[] = []
  const submitted: string[] = []
  const order: string[] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    order.push(e.argv[0])
    if (w.rejects === 'gh' && e.argv[0] === 'gh') return { deny: 'timed out after 30000 ms' } as never
    if (w.rejects === 'sections' && e.argv[0] === 'bash') return { deny: 'timed out after 30000 ms' } as never
    if (e.argv[0] === 'gh' && e.argv[1] === 'api') {
      if (w.login === null) return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials\nmore' } } as never
      return { value: { exitCode: 0, stdout: `${w.login ?? 'alice'}\n`, stderr: '' } } as never
    }
    if (e.argv[0] === 'gh' && (w.down ?? []).some(repo => e.argv.includes(repo))) {
      return { value: { exitCode: 1, stdout: '', stderr: w.stderr ?? 'HTTP 502\nmore' } } as never
    }
    if (e.argv[0] === 'gh') {
      const list = w.list ?? [{ number: 12, headRefOid: SHA, isDraft: false, title: 'feat: retries', comments: w.comments ?? [] }]
      return { value: { exitCode: 0, stdout: w.ghJson ?? JSON.stringify(list), stderr: '' } } as never
    }
    if (w.sectionsExit !== undefined) return { value: { exitCode: w.sectionsExit, stdout: '', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '## Disk\n✓ 27% used\n', stderr: '' } } as never
  })
  on('env.get', () => ({ value: w.czw }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    order.push('open')
    return { value: { isPlaced: true } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  return { ran, opened, submitted, order }
}

type T = Parameters<Parameters<typeof test>[2] & Function>[0]

// A session started with a title, or (title '') with none: then only CZW_SESSION names it.
async function start($: T, title: string) {
  await $.classic.SessionStart({ source: 'resume', ...(title !== '' ? { session_title: title } : {}) } as never)
  await $.session.start({ cwd: '/home/x/projects/my-api', surface: null, isInteractive: true } as never)
}

const drawn = async ($: T) => JSON.stringify(await $.ui.render(PANE))
const reads = (w: { ran: string[][] }) => w.ran.filter(argv => argv[0] === 'gh' && argv[1] === 'pr').length

describe('which sessions', () => {
  test('a session the setting names reads GitHub and opens the pane', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, 'my-coordinator')
    expect(w.opened).toEqual(['side-panel'])
    expect(w.ran.some(argv => argv.join(' ').startsWith('gh pr list -R o/api'))).toBe(true)
  })

  test('another session neither reads nor opens', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, 'my-service')
    expect(w.opened).toEqual([])
    expect(w.ran).toEqual([])
  })

  test('with no repositories and no sections there is nothing to show', { options: { sessions: '' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, 'anything')
    expect(w.opened).toEqual([])
  })
})

describe('Review', () => {
  test('a new head has a Review button that queues the prompt, once', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    await $.ui.render(PANE)
    await $.ui.press({ plugin: 'side-panel', key: `review-o/api#12@${SHA}` })
    expect(w.submitted).toEqual(['Review o/api#12 at b5687a5'])
    const again = await $.ui.render(PANE)
    expect(JSON.stringify(again)).not.toContain('"Review"')
  })

  test('a reviewed head has no Review button', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { comments: [{ body: 'Verdict: approve at b5687a5', author: { login: 'alice' } }] })
    await start($, 'coordinator')
    const drawn = await $.ui.render(PANE)
    expect(JSON.stringify(drawn)).not.toContain('"Review"')
    expect(JSON.stringify(drawn)).toContain('27% used')
  })
})

describe('reading', () => {
  test('the pane reads again every `every` seconds, sections through bash -c', { options: { ...OPTIONS, every: '30' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    expect(reads(w)).toBe(1)
    await clock.advance(29_000)
    expect(reads(w)).toBe(1)
    await clock.advance(1_000)
    expect(reads(w)).toBe(2)
    expect(w.ran).toContainEqual(['bash', '-c', 'print-sections'])
  })

  test('a gh failure shows under the list, and the other repositories still show', { options: { ...OPTIONS, repos: 'o/down o/api' } }, async ($, on) => {
    mock.clock(on)
    world(on, { down: ['o/down'] })
    await start($, 'coordinator')
    const drawn = JSON.stringify(await $.ui.render(PANE))
    expect(drawn).toContain('o/down: HTTP 502')
    expect(drawn).not.toContain('more')
    expect(drawn).toContain('#12')
  })

  test('a sessions pattern that does not compile shows the pane nowhere', { options: { ...OPTIONS, sessions: '(' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, '(')
    expect(w.opened).toEqual([])
  })
})

describe('the session name', () => {
  test('with no title, CZW_SESSION names the session', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { czw: 'coordinator' })
    await start($, '')
    expect(w.opened).toEqual(['side-panel'])
  })

  test('another CZW_SESSION neither reads nor opens', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { czw: 'api' })
    await start($, '')
    expect(w.opened).toEqual([])
    expect(w.ran).toEqual([])
  })

  test('the title, where the engine passes one, comes before CZW_SESSION', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { czw: 'api' })
    await start($, 'coordinator')
    expect(w.opened).toEqual(['side-panel'])
  })

  test('with neither, a sessions setting shows the pane nowhere', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, '')
    expect(w.opened).toEqual([])
  })
})

describe('only where a person is', () => {
  test('a headless session with a matching name neither reads nor opens', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { czw: 'coordinator' })
    await $.session.start({ cwd: '/home/x/projects/my-api', surface: null, isInteractive: false } as never)
    expect(w.opened).toEqual([])
    expect(w.ran).toEqual([])
  })
})

describe('whose reviews count', () => {
  test('a comment by someone not in reviewers keeps Review', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { comments: [{ body: 'Verdict: approve at b5687a5', author: { login: 'bob' } }] })
    await start($, 'coordinator')
    expect(await drawn($)).toContain('"Review"')
  })

  test('a review by a reviewer counts, like a comment', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { list: [{ number: 12, headRefOid: SHA, isDraft: false, title: 't', comments: [], reviews: [{ body: 'Verdict at b5687a5', author: { login: 'alice' } }] }] })
    await start($, 'coordinator')
    expect(await drawn($)).not.toContain('"Review"')
  })

  test('empty reviewers means your own login, read once', { options: { ...OPTIONS, reviewers: '' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { login: 'bob', comments: [{ body: 'Verdict at b5687a5', author: { login: 'bob' } }] })
    await start($, 'coordinator')
    expect(await drawn($)).not.toContain('"Review"')
    await clock.advance(60_000)
    expect(w.ran.filter(argv => argv.join(' ') === 'gh api user -q .login')).toHaveLength(1)
  })

  test('when your login cannot be read, no comment counts and the reason shows', { options: { ...OPTIONS, reviewers: '' } }, async ($, on) => {
    mock.clock(on)
    world(on, { login: null, comments: [{ body: 'Verdict at b5687a5', author: { login: 'alice' } }] })
    await start($, 'coordinator')
    const now = await drawn($)
    expect(now).toContain('"Review"')
    expect(now).toContain('reviewers: HTTP 401: Bad credentials')
  })

  test('gh lists up to 100 pull requests, with their comments and reviews (each with its author)', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    const list = w.ran.find(argv => argv[1] === 'pr') ?? []
    expect(list.join(' ')).toContain('--limit 100')
    expect(list.join(' ')).toContain('comments,reviews')
  })
})

describe('failures', () => {
  test('gh that cannot start or times out still opens the pane, says why, and the timer runs', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { rejects: 'gh' })
    await start($, 'coordinator')
    expect(w.opened).toEqual(['side-panel'])
    const now = await drawn($)
    expect(now).toMatch(/o\/api: [^"]*timed out after 30000 ms/)
    expect(now).toContain('27% used')
    await clock.advance(60_000)
    expect(reads(w)).toBe(2)
  })

  test('a sections command that times out keeps the pull requests and says why', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { rejects: 'sections' })
    await start($, 'coordinator')
    const now = await drawn($)
    expect(now).toContain('#12')
    expect(now).toMatch(/sections: [^"]*timed out after 30000 ms/)
  })

  test('a sections command that fails is reported with its exit code', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { sectionsExit: 3 })
    await start($, 'coordinator')
    expect(await drawn($)).toContain('sections: exit 3')
  })

  test('gh that fails with no stderr says gh failed', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { down: ['o/api'], stderr: '' })
    await start($, 'coordinator')
    expect(await drawn($)).toContain('o/api: gh failed')
  })

  test('an answer from gh that is not JSON is reported', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, { ghJson: '<html>rate limited</html>' })
    await start($, 'coordinator')
    expect(await drawn($)).toContain('o/api: unreadable answer from gh')
  })
})

describe('the pane', () => {
  test('drafts come after the open pull requests', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, {
      list: [
        { number: 7, headRefOid: '9c01e2a' + '0'.repeat(33), isDraft: true, title: 'wip', comments: [] },
        { number: 12, headRefOid: SHA, isDraft: false, title: 'feat: retries', comments: [] },
      ],
    })
    await start($, 'coordinator')
    const now = await drawn($)
    expect(now.indexOf('#12')).toBeGreaterThan(-1)
    expect(now.indexOf('#12')).toBeLessThan(now.indexOf('#7'))
  })

  test('a pressed Review shows again after ten minutes', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    await $.ui.render(PANE)
    await $.ui.press({ plugin: 'side-panel', key: `review-o/api#12@${SHA}` })
    await clock.advance(9 * 60_000)
    expect(await drawn($)).not.toContain('"Review"')
    await clock.advance(60_000)
    expect(await drawn($)).toContain('"Review"')
    await $.ui.press({ plugin: 'side-panel', key: `review-o/api#12@${SHA}` })
    expect(w.submitted).toHaveLength(2)
  })

  test('/panel reads before it shows, and starts the refresh once', { options: { ...OPTIONS, sessions: 'nowhere' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    expect(w.ran).toEqual([])
    await $.command.run({ command: 'panel', args: '' } as never)
    expect(w.order.slice(0, 3)).toEqual(['gh', 'bash', 'open'])
    await $.command.run({ command: 'panel', args: '' } as never)
    expect(reads(w)).toBe(2)
    await clock.advance(60_000)
    expect(reads(w)).toBe(3)
  })
})
