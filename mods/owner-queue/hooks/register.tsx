// owner-queue: the commands only the owner runs, in one queue every session on this machine shares.
// Sessions add to it with the ask_owner_to_run tool; the guard sends held commands to it; the pane
// shows it with a Copy button; the marker in the copied command ticks the item when the owner runs
// it with ! (those commands reach session.append, never tool.call, so the guard never holds them).
import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Item } from './queue'
import { blocker, heldReason, marker, newId, stale, TEXT, visible, withMarker } from './queue'

const PANE = 'owner-queue'
const QUEUE_TOOL = 'mcp__owner-queue__ask_owner_to_run'
const items = atom({ plugin: 'owner-queue', key: 'items' } as const, [] as Item[])
const isPaneShown = atom({ plugin: 'owner-queue', key: 'isPaneShown' } as const, false)
const title = atom({ plugin: 'owner-queue', key: 'title' } as const, '')

// The origins a person's own ! command row carries (a probe on 13/10 saw `unclassified`); a peer
// session, a plugin or a remote bridge never ticks an item.
const OWNER_ORIGINS = new Set(['unclassified', 'composer'])

// Set by register and session.start; a reload runs both again.
const ctx = { dir: '', from: 'session', paneMode: 'auto' }

async function folder($: Engine, configured: string): Promise<string> {
  if (configured !== '') return configured
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.local/state/owner-queue`
}

async function load($: Engine, dir: string): Promise<Item[]> {
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const found: Item[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      found.push(JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Item)
    } catch {
      // A file another session is writing right now: the next refresh reads it.
    }
  }
  return found.sort((a, b) => a.created - b.created)
}

async function save($: Engine, item: Item): Promise<void> {
  if (ctx.dir === '') throw new Error('owner-queue: the queue folder is not known yet')
  await $.fs.write(`${ctx.dir}/${item.id}.json`, JSON.stringify(item, null, 2))
}

// Reads the folder; redraws only when something changed.
async function refresh($: Engine): Promise<Item[]> {
  const now = await load($, ctx.dir)
  const before = await read($, items)
  if (JSON.stringify(before) !== JSON.stringify(now)) await update($, items, () => now)
  return now
}

async function add($: Engine, fields: Pick<Item, 'command' | 'why' | 'after'>): Promise<Item> {
  const now = await $.clock.now()
  const from = (await read($, title)) || ctx.from
  let id = newId(now, Math.random())
  while (await $.fs.exists(`${ctx.dir}/${id}.json`)) id = newId(now, Math.random())
  const item: Item = { ...fields, id, from, status: 'waiting', created: now, updated: now }
  await save($, item)
  await refresh($)
  if (ctx.paneMode === 'auto') await showPane($)
  return item
}

async function setStatus($: Engine, item: Item, status: Item['status'], code?: number): Promise<void> {
  await save($, { ...item, status, code, updated: await $.clock.now() })
  await refresh($)
}

async function showPane($: Engine): Promise<void> {
  const placed = await $.ui.open({ id: PANE, title: 'queue' })
  await update($, isPaneShown, () => placed.isPlaced)
}

// Deletes the files of items removed or done more than a day ago.
async function prune($: Engine): Promise<void> {
  const old = stale(await load($, ctx.dir), await $.clock.now())
  if (old.length > 0) await $.process.run(['rm', '-f', ...old.map(one => `${ctx.dir}/${one.id}.json`)])
}

export const register: Register = (on, options) => {
  ctx.paneMode = (options.pane as string) ?? 'auto'
  const extra = (options.held as string) ?? ''

  on('session.start', async ($, e, next) => {
    ctx.dir = await folder($, (options.dir as string) ?? '')
    ctx.from = e.cwd.split('/').pop() ?? ctx.from
    await $.process.run(['mkdir', '-p', ctx.dir])
    await $.command.register({ name: 'queue', description: 'Show the queue of commands only you run' })
    await $.tool.register({
      name: 'ask_owner_to_run',
      description:
        "Put a command only the owner may run (an infrastructure apply, an AWS write, a repository setting) or a decision only the owner makes in the owner's queue, instead of writing it in your answer. One call per command, in the order they must run; pass the id of the previous one as after. The owner sees it in a pane, runs it with !, and it ticks itself.",
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact shell command, one line. Empty for a decision with no command.' },
          why: { type: 'string', description: 'A few words the owner reads first: what it does and what waits on it.' },
          after: { type: 'string', description: 'The id of the item that must be done first, if any.' },
        },
        required: ['command', 'why'],
      },
      isDeferred: false,
    })
    await prune($)
    const now = await refresh($)
    if (ctx.paneMode === 'auto' && visible(now, await $.clock.now()).length > 0) void showPane($)
    $.clock.every(3000, () => void refresh($))
    return next(e)
  })

  // The session's title, when the session has one (czw starts each with its name). Kept in state,
  // because this event fires once and a reload would otherwise lose it.
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_title === 'string' && e.session_title !== '') {
      const named = e.session_title
      await update($, title, () => named)
    }
    return next(e)
  })

  on('command.run', { command: 'queue' }, async $ => {
    await showPane($)
    return { text: '' }
  })

  on('tool.call', { tool: QUEUE_TOOL }, async ($, e) => {
    const input = e as unknown as { command?: string; why?: string; after?: string }
    const item = await add($, { command: (input.command ?? '').trim(), why: input.why ?? '', after: input.after || undefined })
    return { result: TEXT.queued(item.id) }
  })

  // The guard: every tool whose input is a shell command (Bash, Monitor, and any other).
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string; command?: unknown; description?: unknown }
    if (input.tool === QUEUE_TOOL || typeof input.command !== 'string') return next(e)
    const what = heldReason(input.command, extra)
    if (what === undefined) return next(e)
    const why = typeof input.description === 'string' && input.description !== '' ? input.description : what
    const item = await add($, { command: input.command.trim(), why })
    $.ui.toast(TEXT.held(what, item.id).split(':')[0])
    return { deny: TEXT.held(what, item.id) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'owner-queue: its guard failed, so the command is held.' }))

  // The owner's ! commands arrive here as rows; the last line of their output is the marker.
  on('session.append', async ($, e, next) => {
    const message = e.message as { type?: string; content?: readonly { type: string; text?: string }[] }
    const origin = (e as unknown as { origin?: { kind?: string } }).origin?.kind ?? ''
    if (message.type === 'user' && e.door === 'command' && OWNER_ORIGINS.has(origin)) {
      const ran = marker((message.content ?? []).map(part => part.text ?? '').join('\n'))
      if (ran !== undefined) {
        const item = (await load($, ctx.dir)).find(one => one.id === ran.id)
        if (item !== undefined) await setStatus($, item, ran.code === 0 ? 'done' : 'failed', ran.code)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, items)
    const shown = visible(all, await $.clock.now())
    const open = shown.filter(one => one.status !== 'done')
    const number = (item: Item) => open.indexOf(item) + 1

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={open.length > 0 ? 'red' : 'green'}>
          {open.length > 0 ? TEXT.title(open.length) : TEXT.empty}
        </Text>
        {shown.map(item => {
          const first = blocker(item, all)
          const isDone = item.status === 'done'
          const isFailed = item.status === 'failed'
          return (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text bold={!isDone} dimColor={isDone || first !== undefined} color={isFailed ? 'red' : isDone ? 'green' : undefined}>
                {isDone ? '✓' : isFailed ? '✗' : `${number(item)}`} {item.why}
              </Text>
              <Text dimColor wrap="truncate-end">
                {item.from}
                {first !== undefined ? ` · ${TEXT.after(number(first))}` : ''}
                {isFailed ? ` · ${TEXT.failed(item.code ?? -1)}` : ''}
              </Text>
              {item.command !== '' && (
                <Text dimColor wrap="wrap">
                  {item.command}
                </Text>
              )}
              {!isDone && first === undefined && (
                <Box>
                  {item.command !== '' && (
                    <Button
                      key={`copy-${item.id}`}
                      label={TEXT.copy}
                      onPress={async () => {
                        await $.ui.copy({ text: withMarker(item), surface: e.surface })
                        $.ui.toast(TEXT.copied)
                      }}
                    />
                  )}
                  <Button key={`done-${item.id}`} label={TEXT.done} onPress={() => setStatus($, item, 'done')} />
                  <Button key={`remove-${item.id}`} label={TEXT.remove} onPress={() => setStatus($, item, 'removed')} />
                </Box>
              )}
            </Box>
          )
        })}
        {shown.some(one => one.status === 'done') && (
          <Box marginTop={1}>
            <Button
              key="clear"
              label={TEXT.clear}
              onPress={async () => {
                for (const item of shown.filter(one => one.status === 'done')) await setStatus($, item, 'removed')
              }}
            />
          </Box>
        )}
      </Box>
    )
  })

  // One line above the prompt, only when the pane is not shown.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = visible(await read($, items), await $.clock.now()).filter(one => one.status !== 'done')
    if (open.length === 0 || (await read($, isPaneShown))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="red">● {TEXT.band(open.length)} </Text>
        <Button key="open" label="›" onPress={() => showPane($)} />
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneShown, () => false)
    return next(e)
  })
}
