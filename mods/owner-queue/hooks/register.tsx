// owner-queue: the commands only the owner runs, in one queue every session on this machine shares.
// Sessions add to it with the ask_owner_to_run tool, and list, remove or mark items done with the
// owner_queue_* tools (which change only the pane: they run and approve nothing). The guard refuses
// held commands without queueing them. The pane shows the queue with a Copy button; the marker in
// the copied command ticks the item when the owner runs it with ! (those commands reach
// session.append, never tool.call, so the guard never holds them).
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import { onlyReads, pushDirs } from './guard'
import type { Pushable } from './guard'
import type { Item, Kind } from './queue'
import {
  age, blocker, byLine, fold, heldReason, ID, isKind, KIND_LABEL, KINDS, kindOf, listing, marker, newId, newNonce, nextItem, numberOf,
  openItems, stale, summary, TEXT, visible, waitingFor, who, withMarker,
} from './queue'

const PANE = 'owner-queue'
const TOOL = 'mcp__owner-queue__'
const QUEUE_TOOL = `${TOOL}ask_owner_to_run`
// The mod's own tools: they carry no shell command for the guard. Named one by one, so another
// server's tool that happens to share the prefix is still guarded.
const OWN_TOOLS = new Set([QUEUE_TOOL, `${TOOL}owner_queue_list`, `${TOOL}owner_queue_remove`, `${TOOL}owner_queue_done`])
// How long Remove waits for its second press.
const CONFIRM_MS = 5000
const items = atom({ plugin: 'owner-queue', key: 'items' } as const, [] as Item[])
const isPaneShown = atom({ plugin: 'owner-queue', key: 'isPaneShown' } as const, false)
const title = atom({ plugin: 'owner-queue', key: 'title' } as const, '')
const confirm = atom({ plugin: 'owner-queue', key: 'confirm' } as const, '')
const expanded = atom({ plugin: 'owner-queue', key: 'expanded' } as const, [] as string[])

// The origins a person's own ! command row may carry. What is known: the types name `composer` the
// person's own gesture at the terminal, as the engine stamps it; a probe on this build saw a
// person's ! command row arrive as `unclassified`, which the types call a row with no provenance
// the engine can name. So `unclassified` is what lets a ! row tick, and it does not tell the
// person's ! from another unstamped row: the nonce in the marker (withMarker) is what stops a
// forged one. A peer session, a plugin or a remote bridge carries an origin of its own and never
// ticks an item.
const OWNER_ORIGINS = new Set(['unclassified', 'composer'])

// Set by register and session.start; a reload runs both again. `started` holds the items whose !
// run this session saw start and has not seen print yet.
// `session` is the engine's id of this session, kept in the items it asks for.
const ctx = { dir: '', from: 'session', session: '', paneMode: 'auto', started: new Set<string>() }

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
      const item = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Item
      if (typeof item.id === 'string' && ID.test(item.id)) found.push(item) // an id names a file
    } catch {
      // A file another session is writing right now: the next refresh reads it.
    }
  }
  return found.sort((a, b) => a.created - b.created)
}

async function save($: Engine, item: Item): Promise<void> {
  if (ctx.dir === '') throw new Error('owner-queue: the queue folder is not known yet')
  if (!ID.test(item.id)) throw new Error(`owner-queue: ${JSON.stringify(item.id)} is not an item id`)
  await $.fs.write(`${ctx.dir}/${item.id}.json`, JSON.stringify(item, null, 2))
}

// Reads the folder; redraws only when something changed.
async function refresh($: Engine): Promise<Item[]> {
  const now = await load($, ctx.dir)
  const before = await read($, items)
  if (JSON.stringify(before) !== JSON.stringify(now)) await update($, items, () => now)
  return now
}

// Queues a command, or answers with the item already waiting for it. `agentId` is the subagent's
// loop the call came from (tool.call carries it; absent on the main loop).
async function add($: Engine, fields: Pick<Item, 'command' | 'why' | 'after' | 'kind'>, agentId?: string): Promise<Item> {
  const same = waitingFor(await load($, ctx.dir), fields)
  if (same !== undefined) return same
  const now = await $.clock.now()
  const { from, agent } = await asker($, agentId)
  let id = newId(now, Math.random())
  while (await $.fs.exists(`${ctx.dir}/${id}.json`)) id = newId(now, Math.random())
  const item: Item = {
    ...fields, id, from, ...(agent !== undefined ? { agent } : {}), ...(ctx.session !== '' ? { session: ctx.session } : {}),
    status: 'waiting', created: now, updated: now,
  }
  await save($, item)
  await refresh($)
  if (ctx.paneMode === 'auto') await showPane($)
  return item
}

// This session's name, and the subagent of it whose tool call this is.
async function asker($: Engine, agentId?: string): Promise<{ from: string; agent?: string }> {
  const from = (await read($, title)) || ctx.from
  return agentId === undefined ? { from } : { from, agent: await agentName($, agentId) }
}

// The subagent that asked, as the agent list names it: the description its Agent call gave, else
// its type. One the list does not hold (a workflow's agents, the engine's own forks, one already
// gone) is named by the start of its id.
async function agentName($: Engine, agentId: string): Promise<string> {
  try {
    const found = (await $.agent.list()).find(one => one.id === agentId)
    const name = (found?.description?.split('\n')[0] ?? '').trim() || found?.type
    if (name) return name
  } catch {
    // Named by its id.
  }
  return `agent ${agentId.slice(0, 8)}`
}

async function setStatus($: Engine, item: Item, status: Item['status'], extra: Partial<Item> = {}): Promise<void> {
  await save($, { ...item, status, ...extra, nonce: undefined, running: undefined, updated: await $.clock.now() }) // a tick spends the nonce
  await refresh($)
}

// Removes an open item or marks it done for a tool call or the pane, recording who and why. Read
// again first: another session may have finished it since. Answers what the caller is told.
async function close($: Engine, id: string, status: 'done' | 'removed', by: string, note: string, extra: Partial<Item> = {}): Promise<string> {
  if (!ID.test(id)) return TEXT.badId(id)
  const item = (await load($, ctx.dir)).find(one => one.id === id)
  if (item === undefined) return TEXT.missing(id)
  if (item.status !== 'waiting' && item.status !== 'failed') return TEXT.finished(id, item.status)
  if (status === 'done' && item.running !== undefined) return TEXT.running(id) // the owner's run decides
  await setStatus($, item, status, { by, ...(note !== '' ? { note } : {}), ...extra })
  return TEXT.changed(id, status)
}

// Tells this session, in a row its model reads next turn, about each item it asked for that failed.
// Marked first, so a second session process or the next refresh does not tell it again. The row
// holds only the id (a plain word: load() checked it) and an integer exit code, never the why or
// anything else from the file: any session, or a forged file, wrote those.
async function tellFailures($: Engine, list: readonly Item[]): Promise<void> {
  if (ctx.session === '') return
  for (const item of list) {
    if (item.status !== 'failed' || item.session !== ctx.session || item.noted) continue
    try {
      await save($, { ...item, noted: true })
      const note = TEXT.failedNote(item.id, Number.isInteger(item.code) ? (item.code as number) : -1)
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
      } catch {
        $.ui.toast(note.split('.')[0] ?? item.id)
      }
    } catch {
      // The next refresh tries again.
    }
  }
}

async function showPane($: Engine): Promise<void> {
  const placed = await $.ui.open({ id: PANE, title: 'queue' })
  await update($, isPaneShown, () => placed.isPlaced)
}

// Deletes the files of items removed or done more than a day ago.
async function prune($: Engine): Promise<void> {
  const old = stale(await load($, ctx.dir), await $.clock.now()).filter(one => ID.test(one.id))
  if (old.length > 0) await $.process.run(['rm', '-f', ...old.map(one => `${ctx.dir}/${one.id}.json`)])
}

// The current branch, and the origin URL when the person lists pushable repositories, of each
// folder a push in this command needs (guard.ts), read with git. A folder git cannot read is left
// out, and the guard holds its push.
async function branches($: Engine, command: string, repos: ReadonlySet<string>): Promise<{ found: Map<string, string>; pushable: Pushable }> {
  const found = new Map<string, string>()
  const origins = new Map<string, string>()
  const remotes = new Map<string, string>()
  const pushable = { repos, origins, remotes }
  const dirs = pushDirs(command)
  if (dirs.length === 0) return { found, pushable }
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  for (const dir of dirs) {
    const path = dir === '' ? cwd : dir.startsWith('/') ? dir : dir === '~' || dir.startsWith('~/') ? home + dir.slice(1) : `${cwd}/${dir}`
    try {
      const ran = await $.process.run(['git', '-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])
      if (ran.exitCode === 0 && ran.stdout.trim() !== '') found.set(dir, ran.stdout.trim())
      if (repos.size > 0) {
        const origin = await $.process.run(['git', '-C', path, 'remote', 'get-url', 'origin'])
        if (origin.exitCode === 0 && origin.stdout.trim() !== '') origins.set(dir, origin.stdout.trim())
        const branch = found.get(dir)
        if (branch !== undefined) remotes.set(dir, await pushRemote($, path, branch))
      }
    } catch {
      // Left out: the push is held.
    }
  }
  return { found, pushable }
}

// Where a push with no remote goes from this branch, as git picks it.
async function pushRemote($: Engine, path: string, branch: string): Promise<string> {
  for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`]) {
    const ran = await $.process.run(['git', '-C', path, 'config', '--get', key])
    if (ran.exitCode === 0 && ran.stdout.trim() !== '') return ran.stdout.trim()
  }
  return 'origin'
}

export const register: Register = (on, options) => {
  ctx.paneMode = (options.pane as string) ?? 'auto'
  const extra = (options.held as string) ?? ''
  const repos = new Set(((options.pushable as string) ?? '').split(/\s+/).filter(r => r !== '').map(r => r.toLowerCase()))

  on('session.start', async ($, e, next) => {
    ctx.dir = await folder($, (options.dir as string) ?? '')
    // Who asked, when the session has no title: the name czw gives each session it starts, else the
    // folder's name.
    ctx.from = (await $.env.get('CZW_SESSION')) || (e.cwd.split('/').pop() ?? ctx.from)
    try {
      ctx.session = await $.session.id()
    } catch {
      ctx.session = '' // No failure notes then; the pane still shows the failure.
    }
    await $.process.run(['mkdir', '-p', ctx.dir])
    await $.command.register({ name: 'queue', description: 'Show the queue of commands only you run' })
    await $.tool.register({
      name: 'ask_owner_to_run',
      description:
        "Put a command only the owner may run (an infrastructure apply, an AWS write, a repository setting) or a decision only the owner makes in the owner's queue, instead of writing it in your answer. One call per command, in the order they must run; pass the id of the previous one as after. The owner sees it in a pane, runs it with !, and it ticks itself. Never a read (gh pr view, git log, cat …): run those yourself. To correct an item you queued, pass its id as replaces: the old one is removed.",
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact shell command, one line. Empty for a decision with no command.' },
          why: { type: 'string', description: 'A few words the owner reads first: what it does and what waits on it.' },
          after: { type: 'string', description: 'The id of the item that must be done first, if any.' },
          replaces: { type: 'string', description: 'The id of an item this one replaces; that item is removed.' },
          kind: { type: 'string', enum: [...KINDS], description: 'What it is; inferred when left out (decision when the command is empty).' },
        },
        required: ['command', 'why'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'owner_queue_list',
      description:
        "List the owner's queue: each item's id, number, status (next marks the first the owner can run), kind, why, command, who asked, what it waits on and its age. By default what waits, what failed and what finished in the last hour; all lists everything kept.",
      inputSchema: {
        type: 'object',
        properties: { all: { type: 'boolean', description: 'List every item kept, finished and removed ones included.' } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'owner_queue_remove',
      description:
        "Remove an item from the owner's queue that is no longer needed (asked by mistake, superseded, a read). It only changes the pane: nothing runs. The pane shows who removed it and why.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The item id, as owner_queue_list shows it.' },
          reason: { type: 'string', description: 'Why it is removed, a few words the owner reads.' },
        },
        required: ['id', 'reason'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'owner_queue_done',
      description:
        "Mark an item of the owner's queue done when you verified its effect yourself (the owner ran it elsewhere, or the change is already in place). It only changes the pane: nothing runs and nothing is approved. Say how you verified it.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The item id, as owner_queue_list shows it.' },
          note: { type: 'string', description: 'How you verified it is done.' },
        },
        required: ['id', 'note'],
      },
      isDeferred: false,
    })
    await prune($)
    const now = await refresh($)
    await tellFailures($, now)
    if (ctx.paneMode === 'auto' && visible(now, await $.clock.now()).length > 0) void showPane($)
    $.clock.every(3000, () => void refresh($).then(list => tellFailures($, list)))
    // The ages in the pane move on with the clock, not with the queue.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // The session's title, when the engine passes it: it names who asked before CZW_SESSION and the
  // folder. On this build the event does not reach a mod installed at user level. Kept in state,
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

  // A command that only reads (guard.ts) is the session's to run: it is not queued.
  on('tool.call', { tool: QUEUE_TOOL }, async ($, e) => {
    const input = e as unknown as { command?: string; why?: string; after?: string; replaces?: string; kind?: unknown }
    const command = (input.command ?? '').trim()
    if (onlyReads(command, extra)) return { result: TEXT.reads }
    // The caller's kind, unless the guard reads an AWS change or an infrastructure change: that wins.
    const reason = command === '' ? undefined : heldReason(command, extra)
    const isAws = reason !== undefined && /AWS|infrastructure/.test(reason)
    const kind: Kind = isKind(input.kind) && !isAws ? input.kind : kindOf(command, reason)
    const item = await add($, { command, why: input.why ?? '', after: input.after || undefined, kind }, e.agentId)
    let answer = TEXT.queued(item.id)
    const old = (input.replaces ?? '').trim()
    if (old !== '' && old !== item.id) {
      const { from, agent } = await asker($, e.agentId)
      const removed = await close($, old, 'removed', who(from, agent), TEXT.replaced(item.id))
      answer += removed.startsWith('Not changed') ? ` replaces: ${removed}` : ` ${old} is removed: ${TEXT.replaced(item.id)}.`
    }
    return { result: answer }
  })

  on('tool.call', { tool: `${TOOL}owner_queue_list` }, async ($, e) => {
    const input = e as unknown as { all?: unknown }
    return { result: listing(await refresh($), await $.clock.now(), input.all === true) }
  })

  // Remove and done change only the pane, and any session may use them on any item: who did it
  // and why are kept in the item and shown.
  for (const [tool, status, field] of [
    ['owner_queue_remove', 'removed', 'reason'],
    ['owner_queue_done', 'done', 'note'],
  ] as const) {
    on('tool.call', { tool: `${TOOL}${tool}` }, async ($, e) => {
      const input = e as unknown as Record<string, unknown>
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      const given = input[field]
      const text = typeof given === 'string' ? given.trim() : ''
      if (text === '') return { result: TEXT.needsText(field) }
      const { from, agent } = await asker($, e.agentId)
      return { result: await close($, id, status, who(from, agent), text) }
    })
  }

  // The guard: every tool whose input is a shell command (Bash, Monitor, and any other). A held
  // command is refused and not queued: only ask_owner_to_run adds to the queue.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string; command?: unknown }
    if (OWN_TOOLS.has(input.tool) || typeof input.command !== 'string') return next(e)
    const local = await branches($, input.command, repos)
    const what = heldReason(input.command, extra, local.found, local.pushable)
    if (what === undefined) return next(e)
    return { deny: TEXT.held(what) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'owner-queue: its guard failed, so the command is held.' }))

  // The owner's ! commands arrive here as two rows: the command (<bash-input>), then its output,
  // whose last line is the marker. The command's row spends the nonce, since the model sees that row:
  // from then on only that run's own output can tick the item, and an output without its marker
  // (a run killed, an output cut short) leaves the item for Done.
  on('session.append', async ($, e, next) => {
    const message = e.message as { type?: string; content?: readonly { type: string; text?: string }[] }
    const origin = (e as unknown as { origin?: { kind?: string } }).origin?.kind ?? ''
    if (message.type === 'user' && e.door === 'command' && OWNER_ORIGINS.has(origin)) {
      const text = (message.content ?? []).map(part => part.text ?? '').join('\n')
      if (text.includes('<bash-input>')) {
        for (const item of await load($, ctx.dir)) {
          if (item.nonce === undefined || !text.includes(item.nonce)) continue
          await save($, { ...item, nonce: undefined, running: item.nonce })
          ctx.started.add(item.id)
        }
      } else if (text.includes('<bash-stdout>')) {
        const ran = marker(text)
        for (const item of await load($, ctx.dir)) {
          const isOwn = ran !== undefined && item.id === ran.id && (item.nonce === ran.nonce || item.running === ran.nonce)
          if (isOwn) await setStatus($, item, ran.code === 0 ? 'done' : 'failed', { code: ran.code })
          else if (item.running !== undefined && ctx.started.has(item.id)) await save($, { ...item, running: undefined })
        }
        ctx.started.clear()
        await refresh($)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, items)
    const now = await $.clock.now()
    const shown = visible(all, now)
    const open = openItems(all)
    const next = nextItem(all)
    const confirming = await read($, confirm)
    const whole = new Set(await read($, expanded))
    // d, x and e act on the next item; c copies the first runnable item with a command.
    const keyedCopy = open.find(one => one.status === 'waiting' && one.command !== '' && blocker(one, all) === undefined)

    // Reads the item again before acting: another session may have finished it since the pane was drawn.
    const fresh = async (id: string): Promise<Item | undefined> => {
      const found = (await load($, ctx.dir)).find(one => one.id === id)
      if (found === undefined || (found.status !== 'waiting' && found.status !== 'failed')) {
        await refresh($)
        return undefined
      }
      return found
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text key="summary" bold wrap="truncate-end">
          {summary(all)}
        </Text>
        {open.length > 0 && <Text dimColor>{TEXT.keys}</Text>}
        {shown.map(item => {
          const first = blocker(item, all)
          const number = numberOf(item, all)
          const isNext = item === next
          const isFinished = item.status === 'done' || item.status === 'removed'
          const isFailed = item.status === 'failed'
          const state = isNext ? 'cyan' : isFailed ? 'red' : item.status === 'done' ? 'green' : undefined
          const mark = item.status === 'done' ? '✓' : item.status === 'removed' ? '–' : `${number}`
          const kind = KIND_LABEL[item.kind ?? kindOf(item.command, undefined)]
          const folded = fold(item.command)
          const isWhole = folded.more === 0 || whole.has(item.id)
          const facts = [
            item.id,
            kind,
            who(item.from, item.agent),
            age(now - (isFinished ? item.updated : item.created)),
            isNext ? TEXT.next : undefined,
            first !== undefined ? TEXT.after(numberOf(first, all) ?? first.id) : undefined,
            isFailed ? TEXT.failed(item.code ?? -1) : undefined,
          ].filter(part => part !== undefined)
          return (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text bold={!isFinished} dimColor={isFinished || first !== undefined} color={state} wrap="wrap">
                {`${mark} ${item.why}`}
              </Text>
              <Text dimColor wrap="truncate-end">
                {facts.join(' · ')}
              </Text>
              {item.by !== undefined && isFinished && (
                <Text dimColor wrap="wrap">
                  {`${byLine(item)}${item.note ? `: ${item.note}` : ''}`}
                </Text>
              )}
              {item.command !== '' && (
                <Text dimColor wrap="wrap">
                  {isWhole ? item.command : `${folded.head} ${TEXT.more(folded.more)}`}
                </Text>
              )}
              {!isFinished && (
                <Box>
                  {folded.more > 0 && (
                    <Button
                      key={`fold-${item.id}`}
                      label={isWhole ? TEXT.less : TEXT.expand}
                      {...(isNext ? { hotkey: 'e' } : {})}
                      onPress={() => update($, expanded, ids => (ids.includes(item.id) ? ids.filter(one => one !== item.id) : [...ids, item.id]))}
                    />
                  )}
                  {first === undefined && item.command !== '' && (
                    <Button
                      key={`copy-${item.id}`}
                      label={TEXT.copy}
                      {...(item === keyedCopy ? { hotkey: 'c' } : {})}
                      onPress={async () => {
                        await update($, confirm, () => '')
                        const current = await fresh(item.id)
                        if (current === undefined) return
                        // The nonce is in the item before it is on the clipboard, so a quick run ticks.
                        const nonce = newNonce()
                        await save($, { ...current, nonce })
                        await $.ui.copy({ text: withMarker(current, nonce), surface: e.surface })
                        $.ui.toast(TEXT.copied)
                      }}
                    />
                  )}
                  {first === undefined && (
                    <Button
                      key={`done-${item.id}`}
                      label={TEXT.done}
                      {...(isNext ? { hotkey: 'd' } : {})}
                      onPress={async () => {
                        await update($, confirm, () => '')
                        const current = await fresh(item.id)
                        if (current !== undefined) await setStatus($, current, 'done', { by: 'owner' })
                      }}
                    />
                  )}
                  <Button
                    key={`remove-${item.id}`}
                    label={confirming === item.id ? TEXT.confirm : TEXT.remove}
                    {...(isNext ? { hotkey: 'x' } : {})}
                    onPress={async () => {
                      // Two presses: the first asks, the second removes.
                      if ((await read($, confirm)) !== item.id) {
                        await update($, confirm, () => item.id)
                        $.clock.after(CONFIRM_MS, () => void update($, confirm, id => (id === item.id ? '' : id)))
                        return
                      }
                      await update($, confirm, () => '')
                      const current = await fresh(item.id)
                      if (current !== undefined) await setStatus($, current, 'removed', { by: 'owner', hidden: true })
                    }}
                  />
                </Box>
              )}
            </Box>
          )
        })}
        {shown.some(one => one.status === 'done' || one.status === 'removed') && (
          <Box marginTop={1}>
            <Button
              key="clear"
              label={TEXT.clear}
              onPress={async () => {
                for (const item of shown.filter(one => one.status === 'done' || one.status === 'removed')) await save($, { ...item, hidden: true })
                await refresh($)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })

  // One line above the prompt, only when the pane is not shown.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = openItems(await read($, items))
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
