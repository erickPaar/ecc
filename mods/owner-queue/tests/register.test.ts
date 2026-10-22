import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Item } from '../types'

const DIR = '/q'
const OPTIONS = { dir: DIR, pane: 'off' }
const AUTO = { dir: DIR, pane: 'auto' }

type World = { files: Map<string, string>; copied: string[]; opened: string[]; ran: string[][]; checked: string[] }
type Setup = { isFull?: boolean; isPlaced?: boolean; branch?: string; origin?: string; env?: Record<string, string>; taken?: number }

// A folder in memory beneath the plugin: what $.fs and $.process.run reach in a session, and the
// rest of what the plugin asks of a session, answered plainly. `branch` is what git reads as the
// current branch and `origin` the origin's URL; without one, git fails. The first `taken` item files asked about exist.
function world(on: On, { isFull = false, isPlaced = false, branch, origin, env = {}, taken = 0 }: Setup = {}): World {
  mock.env(on, env)
  const files = new Map<string, string>()
  const ran: string[][] = []
  const checked: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  on('fs.exists', (_$, e) => {
    if (e.path.endsWith('.json')) checked.push(e.path)
    if (e.path.endsWith('.json') && checked.length <= taken) return { value: true }
    return { value: [...files.keys()].some(path => path.startsWith(e.path)) }
  })
  on('fs.list', (_$, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path!.length + 1), kind: 'file' as const, size: files.get(path)!.length, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }) as never)
  on('fs.write', (_$, e) => {
    if (isFull) throw new Error('disk full')
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'rm') for (const path of e.argv.slice(2)) files.delete(path)
    if (e.argv[0] === 'git' && e.argv.includes('get-url')) return { value: origin === undefined ? { exitCode: 2, stdout: '', stderr: 'no such remote' } : { exitCode: 0, stdout: `${origin}\n`, stderr: '' } } as never
    if (e.argv[0] === 'git') return { value: branch === undefined ? { exitCode: 128, stdout: '', stderr: 'not a repository' } : { exitCode: 0, stdout: `${branch}\n`, stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('session.cwd', () => ({ value: '/home/x/projects/my-api' }) as never)
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
  return { files, copied, opened, ran, checked }
}

function queued(w: World): Item[] {
  return [...w.files.values()].map(text => JSON.parse(text) as Item).sort((a, b) => a.created - b.created)
}

// The queue's item at this place, oldest first; a test that finds none fails.
function nth(w: World, at = 0): Item {
  const one = queued(w)[at]
  if (one === undefined) throw new Error(`no item ${at} in the queue`)
  return one
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

// Presses Copy on an item and answers the marker's nonce, as the owner's clipboard holds it.
async function copy($: Dollar, w: World, id: string): Promise<string> {
  await pane($)
  await $.ui.press({ plugin: 'owner-queue', key: `copy-${id}` })
  return /:([a-z0-9]+):\$\?"$/.exec(w.copied[w.copied.length - 1] ?? '')?.[1] ?? ''
}

describe('the guard', () => {
  test('holds an apply from the model and puts it in the queue', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1000 })
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' } }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'make apply STACK=app ENV=dev' } as never)
    expect(String(ran.deny)).toContain('only the owner runs it')
    const held = nth(w)
    expect(held).toMatchObject({ command: 'make apply STACK=app ENV=dev', status: 'waiting', from: 'my-api' })
  })

  test('the tool call\'s description is the why', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'tofu apply', description: 'Apply the network stack' } as never)
    expect(nth(w).why).toBe('Apply the network stack')
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
    world(on, { isFull: true })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'tofu apply' } as never)
    expect(ran.deny).toBeDefined()
  })
})

describe('the guard reads', () => {
  test('a push with no refspec holds on the default branch, read with git in the session\'s folder', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { branch: 'main' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    expect(String(ran.deny)).toContain('push to the default branch')
    expect(w.ran).toContainEqual(['git', '-C', '/home/x/projects/my-api', 'rev-parse', '--abbrev-ref', 'HEAD'])
  })

  test('a push with no refspec passes on another branch', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { branch: 'feat/x' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect((await $.tool.call({ tool: 'Bash', command: 'git -C sub push' } as never)).deny).toBeUndefined()
    expect(w.ran).toContainEqual(['git', '-C', '/home/x/projects/my-api/sub', 'rev-parse', '--abbrev-ref', 'HEAD'])
  })

  const PUSHABLE = { ...OPTIONS, pushable: 'other/x erickPaar/paar-orchestration' }
  test('a push to main of a pushable repository passes, read with git remote get-url', { options: PUSHABLE }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { branch: 'main', origin: 'git@github.com:erickpaar/paar-orchestration.git' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect((await $.tool.call({ tool: 'Bash', command: 'git push' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)).deny).toBeUndefined()
    expect(w.ran).toContainEqual(['git', '-C', '/home/x/projects/my-api', 'remote', 'get-url', 'origin'])
    expect(String((await $.tool.call({ tool: 'Bash', command: 'git push -f origin main' } as never)).deny)).toContain('push to the default branch')
  })

  test('a push to main of another repository, or whose origin git cannot read, is held', { options: PUSHABLE }, async ($, on) => {
    mock.clock(on)
    world(on, { branch: 'main', origin: 'https://github.com/erickPaar/ecc.git' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect(String((await $.tool.call({ tool: 'Bash', command: 'git push' } as never)).deny)).toContain('push to the default branch')
  })

  test('a push to main whose origin git cannot read is held', { options: PUSHABLE }, async ($, on) => {
    mock.clock(on)
    world(on, { branch: 'main' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect(String((await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)).deny)).toContain('push to the default branch')
  })

  test('without pushable, the origin is not read', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { branch: 'main', origin: 'git@github.com:erickPaar/paar-orchestration.git' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect(String((await $.tool.call({ tool: 'Bash', command: 'git push' } as never)).deny)).toContain('push to the default branch')
    expect(w.ran.some(argv => argv.includes('get-url'))).toBe(false)
  })

  test('a push whose branch git cannot read is held', { options: OPTIONS }, async ($, on) => {
    mock.clock(on)
    world(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect(String((await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never)).deny)).toContain('could not read')
  })

  test('the held setting holds more', { options: { ...OPTIONS, held: 'kubectl\\s+delete' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
    await start($)
    expect(String((await $.tool.call({ tool: 'Bash', command: 'kubectl delete pod x' } as never)).deny)).toContain('held by your settings')
    expect((await $.tool.call({ tool: 'Bash', command: 'kubectl get pods' } as never)).deny).toBeUndefined()
    expect(queued(w)).toHaveLength(1)
  })
})

describe('the queue', () => {
  test('asking again for a command that waits answers with the same item', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    const first = await ask($, 'tofu apply')
    await $.tool.call({ tool: 'Bash', command: 'tofu apply' } as never)
    const again = await ask($, 'tofu apply')
    expect(queued(w)).toHaveLength(1)
    expect(String(again.result)).toBe(String(first.result))
  })

  test('a second id is drawn when the first one\'s file exists', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on, { taken: 1 })
    await start($)
    await ask($, 'tofu apply')
    const item = nth(w)
    expect(w.checked).toHaveLength(2)
    expect(w.checked[0]).not.toBe(`${DIR}/${item.id}.json`)
    expect(w.checked[1]).toBe(`${DIR}/${item.id}.json`)
  })

  test('a file whose id is not a plain word is never read, written or deleted', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 300_000_000 })
    const w = world(on)
    const odd: Item = { id: '../../x', command: 'tofu apply', why: 'odd one', from: 's', status: 'waiting', created: 1, updated: 1 }
    w.files.set(`${DIR}/odd.json`, JSON.stringify(odd))
    w.files.set(`${DIR}/old.json`, JSON.stringify({ ...odd, id: '../old', status: 'done' }))
    await start($)
    expect(w.ran.some(argv => argv[0] === 'rm')).toBe(false)
    expect(await pane($)).not.toContain('odd one')
  })

  test('the queue is drawn again only when it changed', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 5000 })
    world(on)
    let writes = 0
    on('state.set', (_$, e, next) => {
      if ((e as { key?: string }).key === 'items') writes += 1
      return next(e)
    })
    await start($)
    await ask($, 'tofu apply')
    const before = writes
    await clock.advance(9000)
    expect(writes).toBe(before)
  })
})

describe('who asked', () => {
  test('an item names the session by its title when the engine passes it', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on, { env: { CZW_SESSION: 'workspace-pane' } })
    await start($)
    await $.classic.SessionStart({ source: 'resume', session_title: 'review-session' } as never)
    await ask($, 'tofu apply')
    expect(nth(w).from).toBe('review-session')
  })

  test('else by the name czw gave the session', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on, { env: { CZW_SESSION: 'workspace-pane' } })
    await start($)
    await ask($, 'tofu apply')
    expect(nth(w).from).toBe('workspace-pane')
  })

  test('else by its folder', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'tofu apply')
    expect(nth(w).from).toBe('my-api')
  })
})

describe('the tick', () => {
  test('the owner\'s ! run ticks an item by the marker on its last line', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    const asked = await ask($, 'make apply STACK=network')
    const item = nth(w)
    expect(String(asked.result)).toContain(item.id)
    const nonce = await copy($, w, item.id)
    await row($, `<bash-stdout>Apply complete!\noq:${item.id}:${nonce}:0</bash-stdout><bash-stderr></bash-stderr>`)
    expect(nth(w).status).toBe('done')
  })

  test('a failed run is marked failed with its exit code', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=storage')
    const nonce = await copy($, w, nth(w).id)
    await row($, `<bash-stdout>oq:${nth(w).id}:${nonce}:2</bash-stdout>`)
    expect(nth(w)).toMatchObject({ status: 'failed', code: 2 })
  })

  test('the nonce is made at Copy and is in no tool result or refusal the model sees', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    await $.tool.call({ tool: 'Bash', command: 'tofu destroy' } as never)
    expect(queued(w).every(one => one.nonce === undefined)).toBe(true)
    for (const one of queued(w)) await copy($, w, one.id)
    const nonces = queued(w).map(one => one.nonce ?? '')
    expect(nonces.every(n => n.length === 16)).toBe(true)
    // Asked again, each answers with the item that waits: its id, never its nonce.
    const seen = [await ask($, 'make apply STACK=network'), await $.tool.call({ tool: 'Bash', command: 'tofu destroy' } as never)]
    for (const n of nonces) expect(JSON.stringify(seen)).not.toContain(n)
    expect(JSON.stringify(seen)).toContain(nth(w).id)
  })

  test('a queued command cannot forge another item\'s tick', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const victim = nth(w)
    await copy($, w, victim.id)
    // The forged command prints the victim's old-style marker, then kills its shell before its own.
    await ask($, `echo oq:${victim.id}:0; echo oq:${victim.id}:guess:0; kill -9 $$`)
    const forger = queued(w).find(one => one.id !== victim.id)!
    await copy($, w, forger.id)
    await row($, `<bash-stdout>oq:${victim.id}:0</bash-stdout>`)
    await row($, `<bash-stdout>oq:${victim.id}:0\noq:${victim.id}:guess:0</bash-stdout>`)
    expect(queued(w).find(one => one.id === victim.id)?.status).toBe('waiting')
  })

  test('a tick spends the nonce, so a marker seen once never ticks again', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const item = nth(w)
    const nonce = await copy($, w, item.id)
    await row($, `<bash-stdout>oq:${item.id}:${nonce}:1</bash-stdout>`)
    await row($, `<bash-stdout>oq:${item.id}:${nonce}:0</bash-stdout>`)
    expect(nth(w)).toMatchObject({ status: 'failed', code: 1 })
    expect(nth(w).nonce).toBeUndefined()
  })

  test('the ! run that carries the nonce spends it, so only its own output ticks', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const item = nth(w)
    const nonce = await copy($, w, item.id)
    await row($, `<bash-input>${w.copied[0]}</bash-input>`)
    expect(nth(w).nonce).toBeUndefined()
    await row($, `<bash-stdout>Apply complete!\noq:${item.id}:${nonce}:0</bash-stdout><bash-stderr></bash-stderr>`)
    expect(nth(w)).toMatchObject({ status: 'done' })
    expect(nth(w).running).toBeUndefined()
  })

  test('a ! run that leaves no marker spends the nonce', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const item = nth(w)
    const nonce = await copy($, w, item.id)
    await row($, `<bash-input>${w.copied[0]}</bash-input>`)
    await row($, '<bash-stdout>Killed</bash-stdout><bash-stderr></bash-stderr>')
    expect(nth(w)).toMatchObject({ status: 'waiting' })
    expect(nth(w).running).toBeUndefined()
    // The model has seen the nonce in the ! row now; a command that prints it later ticks nothing.
    await row($, `<bash-stdout>oq:${item.id}:${nonce}:0</bash-stdout>`)
    expect(nth(w).status).toBe('waiting')
  })

  test('a ! row from another person or a peer never spends the nonce', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const nonce = await copy($, w, nth(w).id)
    await row($, `<bash-input>${w.copied[0]}</bash-input>`, { origin: 'peer' })
    expect(nth(w).nonce).toBe(nonce)
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
      const nonce = await copy($, w, nth(w).id)
      await row($, `<bash-stdout>oq:${nth(w).id}:${nonce}:0</bash-stdout>`, fields)
      expect(nth(w).status).toBe('waiting')
    })
  }
})

describe('the pane', () => {
  test('Copy puts the command with its marker on the clipboard', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const item = nth(w)
    await pane($)
    await $.ui.press({ plugin: 'owner-queue', key: `copy-${item.id}` })
    const { nonce } = nth(w)
    expect(w.copied).toEqual([`(set -o pipefail; make apply STACK=network); echo "oq:${item.id}:${nonce}:$?"`])
  })

  test('Copy on an item finished elsewhere since the pane was drawn does not reopen it', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const item = nth(w)
    await pane($)
    w.files.set(`${DIR}/${item.id}.json`, JSON.stringify({ ...item, status: 'done', updated: 5000 }))
    await $.ui.press({ plugin: 'owner-queue', key: `copy-${item.id}` })
    expect(nth(w)).toMatchObject({ status: 'done' })
    expect(nth(w).nonce).toBeUndefined()
    expect(w.copied).toEqual([])
  })

  test('a decision with no command has Done and Remove, and no Copy', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, '')
    const item = nth(w)
    const drawn = await pane($)
    expect(drawn).toContain(`done-${item.id}`)
    expect(drawn).not.toContain(`copy-${item.id}`)
  })

  test('an item that waits for another has no buttons until that one is done', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 5000 })
    const w = world(on)
    await start($)
    await ask($, 'make apply STACK=network')
    const first = nth(w)
    await ask($, 'make apply STACK=storage', first.id)
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
    const [a, b] = [nth(w, 0), nth(w, 1)]
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
    const w = world(on, { isPlaced: true })
    await start($)
    expect(w.opened).toEqual([])
    await ask($, 'tofu apply')
    expect(w.opened).toContain('owner-queue')
  })

  test('the band shows only while the pane is not shown', { options: AUTO }, async ($, on) => {
    mock.clock(on)
    world(on)
    await start($)
    await ask($, 'tofu apply')
    const band = JSON.stringify(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} } as never))
    expect(band).toContain('1 waiting for you')
  })

  test('the band stays out of the way while the pane is shown', { options: AUTO }, async ($, on) => {
    mock.clock(on)
    world(on, { isPlaced: true })
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
    const other: Item = { id: 'other1', command: 'tofu apply', why: 'from elsewhere', from: 'other-session', status: 'waiting', created: 6000, updated: 6000 }
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
