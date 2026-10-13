import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SHA = 'b5687a5e1c0d2f3a4b5c6d7e8f9a0b1c2d3e4f5a'
const OPTIONS = { sessions: 'coordinator', repos: 'o/api', reviewed: 'Verdict', sections: 'print-sections', review_prompt: 'Review {repo}#{number} at {sha}' }

// What a session answers beneath the plugin: gh, the sections command, and the start-up calls.
// gh fails for the repositories in `down`.
function world(on: On, comments: { body: string }[] = [], down: string[] = []) {
  const ran: string[][] = []
  const opened: string[] = []
  const submitted: string[] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'gh' && down.some(repo => e.argv.includes(repo))) {
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502\nmore' } } as never
    }
    if (e.argv[0] === 'gh') {
      const list = [{ number: 12, headRefOid: SHA, isDraft: false, title: 'feat: retries', comments }]
      return { value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: '## Disk\n✓ 27% used\n', stderr: '' } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  return { ran, opened, submitted }
}

async function start($: Parameters<Parameters<typeof test>[2] & Function>[0], title: string) {
  await $.classic.SessionStart({ source: 'resume', session_title: title } as never)
  await $.session.start({ cwd: '/home/x/projects/my-api', surface: null, isInteractive: true } as never)
}

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
    await $.ui.render({ component: 'Pane', requestId: 'side-panel', surface: 'terminal', props: {} } as never)
    await $.ui.press({ plugin: 'side-panel', key: `review-o/api#12@${SHA}` })
    expect(w.submitted).toEqual(['Review o/api#12 at b5687a5'])
    const again = await $.ui.render({ component: 'Pane', requestId: 'side-panel', surface: 'terminal', props: {} } as never)
    expect(JSON.stringify(again)).not.toContain('"Review"')
  })

  test('a reviewed head has no Review button', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, [{ body: 'Verdict: approve at b5687a5' }])
    await start($, 'coordinator')
    const drawn = await $.ui.render({ component: 'Pane', requestId: 'side-panel', surface: 'terminal', props: {} } as never)
    expect(JSON.stringify(drawn)).not.toContain('"Review"')
    expect(JSON.stringify(drawn)).toContain('27% used')
  })
})

describe('reading', () => {
  test('the pane reads again every `every` seconds, sections through bash -c', { options: { ...OPTIONS, every: '30' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($, 'coordinator')
    const reads = () => w.ran.filter(argv => argv[0] === 'gh').length
    expect(reads()).toBe(1)
    await clock.advance(29_000)
    expect(reads()).toBe(1)
    await clock.advance(1_000)
    expect(reads()).toBe(2)
    expect(w.ran).toContainEqual(['bash', '-c', 'print-sections'])
  })

  test('a gh failure shows under the list, and the other repositories still show', { options: { ...OPTIONS, repos: 'o/down o/api' } }, async ($, on) => {
    mock.clock(on)
    world(on, [], ['o/down'])
    await start($, 'coordinator')
    const drawn = JSON.stringify(await $.ui.render({ component: 'Pane', requestId: 'side-panel', surface: 'terminal', props: {} } as never))
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
