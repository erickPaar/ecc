import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Item } from '../types'

const DIR = '/q'
const OPTIONS = { dir: DIR, pane: 'off' }
const AUTO = { dir: DIR, pane: 'auto' }

type World = { files: Map<string, string>; copied: string[]; opened: string[] }

// A folder in memory beneath the plugin: what $.fs and $.process.run reach in a session, and the
// rest of what the plugin asks of a session, answered plainly.
function world(on: On, isFull = false, isPlaced = false): World {
  const files = new Map<string, string>()
  const copied: string[] = []
  const opened: string[] = []
  on('fs.exists', (_$, e) => ({ value: [...files.keys()].some(path => path.startsWith(e.path)) }))
  on('fs.list', (_$, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path!.length + 1), kind: 'file' as const, size: files.get(path)!.length })),
  }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }) as never)
  on('fs.write', (_$, e) => {
    if (isFull) throw new Error('disk full')
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') for (const path of e.argv.slice(2)) files.delete(path)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$, e) => ({ value: e }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  // What the engine draws above the prompt when no plugin draws there.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced } } as never
  })
  return { files, copied, opened }
}

function queued(w: World): Item[] {
  return [...w.files.values()].map(text => JSON.parse(text) as Item).sort((a, b) => a.created - b.created)
}

type Dollar = Parameters<Parameters<typeof test>[2] & Function>[0]

async function start($: Dollar) {
  await $.session.start({ cwd: '/home/x/projects/my-api', surface: null, isInteractive: true } as never)
}

async function ask($: Dollar, command: string, after?: string) {
  return $.tool.call({ tool: 'mcp__owner-queue__ask_owner_to_run', command, why: command, ...(after ? { after } : {}) } as never)
}

// A row as the session stores it: by default the owner's own ! command.
async function row($: Dollar, text: string, fields: { door?: string; type?: string; origin?: string } = {}) {
  const type = fields.type ?? 'user'
  await $.session.append({
    message: { type, role: type, content: [{ type: 'text', text }] },
    door: fields.door ?? 'command',
    origin: { kind: fields.origin ?? 'unclassified' },
  } as never)
}

async function pane($: Dollar) {
  return JSON.stringify(await $.ui.render({ component: 'Pane', requestId: 'owner-queue', surface: 'terminal', props: {} } as never))
}

describe('the guard', () => {
  test('holds an apply from the model and puts it in the queue', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1000 })
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' } }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'make apply STACK=app ENV=dev' } as never)
    expect(String(ran.deny)).toContain('only the owner runs it')
    const [held] = queued(w)
    expect(held).toMatchObject({ command: 'make apply STACK=app ENV=dev', status: 'waiting', from: 'my-api' })
  })

  test('the tool call\'s description is the why', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'tofu apply', description: 'Apply the agent stack' } as never)
    expect(queued(w)[0].why).toBe('Apply the agent stack')
  })

  test('guards every tool that runs a shell command, Monitor included', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    on('tool.call', { tool: 'Monitor' }, () => ({ result: 'watching', text: 'watching' }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Monitor', command: 'tofu apply -auto-approve', description: 'watch the apply' } as never)
    expect(ran.deny).toBeDefined()
    expect(queued(w)).toHaveLength(1)
  })

  test('lets everything else run', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'tofu plan' } as never)
    expect(ran.deny).toBeUndefined()
    expect(queued(w)).toEqual([])
  })

  test('when the queue cannot be written, the held command is still refused', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on, true)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'tofu apply' } as never)
    expect(ran.deny).toBeDefined()
  })
})

describe('who asked', () => {
  test('an item names the session by its title when it has one', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await $.classic.SessionStart({ source: 'resume', session_title: 'pi-service' } as never)
    await ask($, 'tofu apply')
    expect(queued(w)[0].from).toBe('pi-service')
  })
})

describe('the tick', () => {
  test('the owner\'s ! run ticks an item by the marker on its last line', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    const asked = await ask($, 'make apply STACK=network')
    const [item] = queued(w)
    expect(String(asked.result)).toContain(item.id)
    await row($, `<bash-stdout>Apply complete!\noq:${item.id}:0</bash-stdout><bash-stderr></bash-stderr>`)
    expect(queued(w)[0].status).toBe('done')
  })

  test('a failed run is marked failed with its exit code', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=content')
    await row($, `<bash-stdout>oq:${queued(w)[0].id}:2</bash-stdout>`)
    expect(queued(w)[0]).toMatchObject({ status: 'failed', code: 2 })
  })

  for (const [name, fields] of [
    ['a peer session', { origin: 'peer' }],
    ['a plugin', { origin: 'plugin' }],
    ['a typed prompt', { door: 'prompt', origin: 'composer' }],
    ['the model\'s answer', { door: 'response', type: 'assistant' }],
  ] as const) {
    test(`a marker from ${name} ticks nothing`, { options: OPTIONS }, async ($, on) => {
      mock.clock(on, { now: 5000 })
      const w = world(on)
      await start($)
      await ask($, 'make apply STACK=app')
      await row($, `<bash-stdout>oq:${queued(w)[0].id}:0</bash-stdout>`, fields)
      expect(queued(w)[0].status).toBe('waiting')
    })
  }
})

describe('the pane', () => {
  test('Copy puts the command with its marker on the clipboard', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const [item] = queued(w)
    await pane($)
    await $.ui.press({ plugin: 'owner-queue', key: `copy-${item.id}` })
    expect(w.copied).toEqual([`(set -o pipefail; make apply STACK=network); echo "oq:${item.id}:$?"`])
  })

  test('an item that waits for another has no buttons until that one is done', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const [first] = queued(w)
    await ask($, 'make apply STACK=content', first.id)
    const second = queued(w).find(one => one.id !== first.id)!
    const drawn = await pane($)
    expect(drawn).toContain(`copy-${first.id}`)
    expect(drawn).not.toContain(`copy-${second.id}`)
    expect(drawn).toContain('after 1')
    await $.ui.press({ plugin: 'owner-queue', key: `done-${first.id}` })
    expect(await pane($)).toContain(`copy-${second.id}`)
  })

  test('Done and Remove are on every open item; Clear removes the finished', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    await ask($, 'echo hi # a comment')
    const [a, b] = queued(w)
    const drawn = await pane($)
    for (const id of [a.id, b.id]) {
      expect(drawn).toContain(`done-${id}`)
      expect(drawn).toContain(`remove-${id}`)
    }
    await $.ui.press({ plugin: 'owner-queue', key: `remove-${b.id}` })
    expect(queued(w).find(one => one.id === b.id)?.status).toBe('removed')
    await $.ui.press({ plugin: 'owner-queue', key: `done-${a.id}` })
    await pane($)
    await $.ui.press({ plugin: 'owner-queue', key: 'clear' })
    expect(queued(w).find(one => one.id === a.id)?.status).toBe('removed')
  })

  test('auto opens the pane when something is queued', { options: AUTO }, async ($, on) => {
    mock.clock(on)
    const w = world(on, false, true)
    await start($)
    expect(w.opened).toEqual([])
    await ask($, 'tofu apply')
    expect(w.opened).toContain('owner-queue')
  })

  test('the band shows only while the pane is not shown', { options: AUTO }, async ($, on) => {
    mock.clock(on)
    world(on, false, false)
    await start($)
    await ask($, 'tofu apply')
    const band = JSON.stringify(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} } as never))
    expect(band).toContain('1 waiting for you')
  })

  test('the band stays out of the way while the pane is shown', { options: AUTO }, async ($, on) => {
    mock.clock(on)
    world(on, false, true)
    await start($)
    await ask($, 'tofu apply')
    const band = JSON.stringify(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} } as never))
    expect(band).not.toContain('waiting for you')
  })
})

describe('upkeep', () => {
  test('the queue folder is read again on a timer, so other sessions\' items appear', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    const other: Item = { id: 'other1', command: 'tofu apply', why: 'from elsewhere', from: 'pi-content', status: 'waiting', created: 6000, updated: 6000 }
    w.files.set(`${DIR}/other1.json`, JSON.stringify(other))
    await clock.advance(3000)
    expect(await pane($)).toContain('from elsewhere')
  })

  test('old finished and removed items are deleted at start', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 300_000_000 })
    const w = world(on)
    const old: Item = { id: 'old111', command: 'x', why: 'x', from: 's', status: 'done', created: 1, updated: 1 }
    const open: Item = { id: 'open11', command: 'y', why: 'y', from: 's', status: 'waiting', created: 1, updated: 1 }
    w.files.set(`${DIR}/old111.json`, JSON.stringify(old))
    w.files.set(`${DIR}/open11.json`, JSON.stringify(open))
    await start($)
    expect([...w.files.keys()]).toEqual([`${DIR}/open11.json`])
  })
})
