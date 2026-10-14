// A small reader of shell commands: it splits a command line into the simple commands a shell
// would run, each as its argument list with the quotes taken off, and it opens what runs inside
// others ($(…), backticks, subshells, heredocs, here-strings and pipes read by a shell, unquoted
// heredocs' substitutions). It is not a full shell: it reads well-formed commands the way bash
// would, and anything it cannot read stays in the words, where the rules still see it.

const SEPARATORS = new Set([';', '&', '\n', '(', ')'])

// Deeper than this, the reader stops and the guard holds the command (guard.ts).
export const MAX_DEPTH = 8
export class TooDeep extends Error {}

type Heredoc = { tag: string; isQuoted: boolean; argv: string[] }

// Every simple command the text runs, nested ones included, as argument lists.
export function commands(text: string, depth = 0): string[][] {
  if (depth > MAX_DEPTH) throw new TooDeep('nested too deeply')
  const src = text
  const out: string[][] = []
  let argv: string[] = []
  let word = ''
  let hasWord = false
  let pending: Heredoc[] = []
  // The next word is a redirection's target (dropped), or a here-string's text (kept for a shell).
  let target: 'file' | 'string' | undefined
  let hereStrings: string[] = []
  // The commands earlier in this pipeline (a | b | c), whose output a shell would read.
  let upstream: string[][] = []
  let i = 0

  const nested = (inner: string) => out.push(...commands(inner, depth + 1))
  const endWord = () => {
    if (hasWord) {
      if (target === 'string') hereStrings.push(word)
      else if (target === undefined) argv.push(word)
      target = undefined
    }
    word = ''
    hasWord = false
  }
  const endCommand = (isPiped = false) => {
    endWord()
    target = undefined
    if (argv.length > 0) {
      out.push(argv)
      // What a shell reads on its standard input is commands: a here-string, or what the commands
      // before it in the pipeline print (judged by their arguments: `echo 'tofu apply' | bash`).
      // xargs adds what it reads to its own command.
      if (readsCommands(argv)) {
        for (const text of [...hereStrings, ...upstream.map(stdinText)]) nested(text)
      } else if (upstream.length > 0 && ['xargs', 'parallel'].includes(program(unwrap(argv)[0] ?? ''))) {
        for (const inner of handedOver(argv)) nested(`${inner} ${upstream.map(stdinText).join(' ')}`)
      }
      upstream = isPiped ? [...upstream, argv] : []
    } else if (!isPiped) upstream = []
    argv = []
    hereStrings = []
  }

  while (i < src.length) {
    const c = src[i] ?? ''

    if (c === '\\' && i + 1 < src.length) {
      // A backslash before a newline joins the lines; before anything else, it quotes that one
      // character, so `\\` at a line's end is a backslash and the line ends.
      if (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n')) {
        i += src[i + 1] === '\n' ? 2 : 3
        continue
      }
      word += src[i + 1]
      hasWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) {
        word += src.slice(i + 1)
        hasWord = true
        break
      }
      word += src.slice(i + 1, end)
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '$' && src[i + 1] === "'") {
      let end = i + 2
      while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1
      word += src.slice(i + 2, end).replace(/\\(.)/g, '$1')
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && src[j + 1] === '\n') {
          j += 2
        } else if (src[j] === '\\' && j + 1 < src.length) {
          word += src[j + 1]
          j += 2
        } else if (src[j] === '$' && src[j + 1] === '(') {
          const end = closing(src, j + 1)
          nested(src.slice(j + 2, end))
          j = end + 1
        } else if (src[j] === '`') {
          const end = src.indexOf('`', j + 1)
          nested(src.slice(j + 1, end < 0 ? src.length : end))
          j = end < 0 ? src.length : end + 1
        } else {
          word += src[j]
          j += 1
        }
      }
      hasWord = true
      i = j + 1
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = closing(src, i + 1)
      nested(src.slice(i + 2, end))
      hasWord = true // the substitution's output is part of this word
      i = end + 1
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      nested(src.slice(i + 1, end < 0 ? src.length : end))
      hasWord = true
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === '#' && !hasWord) {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord()
      i += 2
      if (src[i] === '-') i += 1
      while (src[i] === ' ' || src[i] === '\t') i += 1
      const m = /^(['"]?)([A-Za-z_][\w-]*)\1/.exec(src.slice(i))
      if (m) {
        pending.push({ tag: m[2] ?? '', isQuoted: m[1] !== '', argv })
        i += m[0].length
      }
      continue
    }
    if (c === '>' || c === '<') {
      // A redirection: drop a file descriptor number written just before it; the next word is its
      // target, read with its quotes like any word.
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else endWord()
      if (src.startsWith('<<<', i)) {
        target = 'string'
        i += 3
      } else {
        target = 'file'
        i += 1
        while (src[i] === '>' || src[i] === '<' || src[i] === '&' || src[i] === '|') i += 1
      }
      while (src[i] === ' ' || src[i] === '\t') i += 1
      continue
    }
    if (c === '\n' && pending.length > 0) {
      endCommand()
      i += 1
      for (const doc of pending) {
        const lines: string[] = []
        while (i < src.length) {
          const eol = src.indexOf('\n', i)
          const line = src.slice(i, eol < 0 ? src.length : eol)
          i = eol < 0 ? src.length : eol + 1
          if (line.replace(/^\t+/, '').trim() === doc.tag) break
          lines.push(line)
        }
        const body = lines.join('\n')
        // Read as commands when its own program is a shell, or when it is piped into one
        // (`cat <<EOF | bash`): any command after it on the same line.
        const at = out.indexOf(doc.argv)
        const sameLine = at < 0 ? [doc.argv] : out.slice(at)
        if (sameLine.some(one => readsCommands(one))) nested(body)
        else if (!doc.isQuoted) for (const inner of substitutions(body)) nested(inner)
      }
      pending = []
      continue
    }
    if (c === '|') {
      // `||` ends a pipeline; `|` and `|&` carry on to the next command.
      const isOr = src[i + 1] === '|'
      endCommand(!isOr)
      i += isOr || src[i + 1] === '&' ? 2 : 1
      continue
    }
    if (SEPARATORS.has(c)) {
      endCommand()
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
      continue
    }
    word += c
    hasWord = true
    i += 1
  }
  endCommand()
  return out
}

// What a command in a pipeline gives a shell to read: its arguments, with \n read as a newline
// (printf's and echo -e's).
function stdinText(argv: readonly string[]): string {
  return unwrap(argv).slice(1).join(' ').replace(/\\n/g, '\n')
}

// The index of the ) that closes the ( at `open`, skipping quoted text.
function closing(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i] ?? ''
    if (c === '\\') i += 1
    else if (c === "'") i = Math.max(i, src.indexOf("'", i + 1))
    else if (c === '"') i = closingQuote(src, i)
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return src.length
}

// The index of the " that closes the " at `open`; a $(…) inside it may hold quotes of its own.
function closingQuote(src: string, open: number): number {
  for (let j = open + 1; j < src.length; j += 1) {
    if (src[j] === '\\') j += 1
    else if (src[j] === '$' && src[j + 1] === '(') j = closing(src, j + 1)
    else if (src[j] === '"') return j
  }
  return src.length
}

// What $(…) and backticks hold in a text that is not otherwise read as commands.
function substitutions(text: string): string[] {
  const found: string[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = closing(text, i + 1)
      found.push(text.slice(i + 2, end))
      i = end
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end < 0) break
      found.push(text.slice(i + 1, end))
      i = end
    }
  }
  return found
}

// Programs that run what they are given as commands, not as data.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

export function program(word = ''): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

// The words after a command's options. Each option in `values` takes the next word as its value;
// an attached value (-n5, --signal=KILL) is one word.
function afterOptions(args: readonly string[], values: readonly string[]): string[] {
  let i = 0
  while (i < args.length && nth(args, i).startsWith('-') && args[i] !== '-') {
    i += values.includes(nth(args, i)) ? 2 : 1
  }
  return args.slice(i)
}

// Wrappers that run the rest of their arguments as a command: their options that take a value,
// and how many words come between the options and the command (timeout's duration, flock's file).
const ENV_VALUES = ['-u', '--unset', '-C', '--chdir']
const WRAPPERS: Record<string, { values: string[]; skip?: number }> = {
  env: { values: ENV_VALUES },
  command: { values: [] },
  exec: { values: ['-a'] },
  nohup: { values: [] },
  time: { values: ['-f', '--format', '-o', '--output'] },
  sudo: {
    values: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt',
      '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout', '-R', '--chroot'],
  },
  doas: { values: ['-u', '-C'] },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '--class', '-n', '--classdata'] },
  chrt: { values: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], skip: 1 },
  taskset: { values: [], skip: 1 },
  stdbuf: { values: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  caffeinate: { values: ['-w', '-t'] },
  timeout: { values: ['-k', '--kill-after', '-s', '--signal'], skip: 1 },
  flock: { values: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], skip: 1 },
}

// Words that open a compound command or a function; the command after them runs.
const KEYWORDS = new Set(['{', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until'])

// The argument list after assignments, keywords and wrappers (env, sudo, timeout 5, nohup …), so
// the program that really runs comes first. `su -c` and `flock … -c` become `sh -c`, which
// handedOver opens.
export function unwrap(argv: readonly string[]): string[] {
  let rest = [...argv]
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(nth(rest, 0))) rest = rest.slice(1)
    const name = program(rest[0] ?? '')
    const wrapper = own(WRAPPERS, name)
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(rest[1] ?? '')) return [] // command -v prints, runs nothing
    if (wrapper !== undefined) {
      const args = name === 'env' ? splitString(rest.slice(1)) : rest.slice(1)
      rest = afterOptions(args, wrapper.values).slice(wrapper.skip ?? 0)
      if (name === 'flock' && (rest[0] === '-c' || rest[0] === '--command')) rest = ['sh', ...rest]
      continue
    }
    if (name === 'su') {
      const at = rest.findIndex(a => a === '-c' || a === '--command' || a.startsWith('--command='))
      if (at < 0) return ['sh'] // a shell that reads its commands from standard input
      const a = nth(rest, at)
      return ['sh', '-c', a.startsWith('--command=') ? a.slice(10) : (rest[at + 1] ?? '')]
    }
    if (name === 'direnv' && rest[1] === 'exec') {
      rest = rest.slice(3) // the folder whose environment it loads
      continue
    }
    if (name === 'aws-vault' && rest[1] === 'exec') {
      const end = rest.indexOf('--')
      rest = end >= 0 ? rest.slice(end + 1) : afterOptions(rest.slice(2), ['-d', '--duration', '-t', '--mfa-token', '--region', '--prompt']).slice(1)
      continue
    }
    if (name === 'coproc') {
      rest = rest[2] === '{' ? rest.slice(2) : rest.slice(1) // coproc NAME { …; }
      continue
    }
    if (name === 'function') {
      rest = rest.slice(2) // function NAME { …; }
      continue
    }
    if (KEYWORDS.has(name)) {
      rest = rest.slice(1)
      continue
    }
    break
  }
  return rest
}

// env -S (--split-string) splits its value into the command's words, in its place.
function splitString(args: readonly string[]): string[] {
  for (let i = 0; i < args.length && nth(args, i).startsWith('-') && args[i] !== '--'; i += 1) {
    const [, attached] = /^(?:-S|--split-string=?)(.*)$/.exec(nth(args, i)) ?? []
    if (attached === undefined) {
      if (ENV_VALUES.includes(nth(args, i))) i += 1
      continue
    }
    const value = attached !== '' ? attached : nth(args, i + 1)
    const after = attached !== '' ? i + 1 : i + 2
    return [...args.slice(0, i), ...value.split(/\s+/).filter(Boolean), ...args.slice(after)]
  }
  return [...args]
}

// Whether what this command reads on its standard input (a heredoc, a here-string, a pipe) is run
// as commands: a shell, or a program that hands its command to one (`docker exec -i c sh`).
export function readsCommands(argv: readonly string[], depth = 0): boolean {
  const run = unwrap(argv)
  const name = program(run[0] ?? '')
  if (SHELLS.has(name) || name === 'ssh' || name === 'eval' || name === 'source' || name === '.') return true
  return depth < 2 && handedOver(argv).some(inner => commands(inner).some(one => readsCommands(one, depth + 1)))
}

// Options that take a value, for the programs that run a command in a container.
const CONTAINER_VALUES = ['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--name', '--entrypoint', '-l',
  '--label', '-v', '--volume', '-p', '--publish', '--network', '--mount', '--platform', '--pull', '--index', '--detach-keys',
  '-f', '--file', '-H', '--host', '-c', '--context', '--config', '--cpu-shares', '--project-name', '--project-directory', '--profile', '--ansi', '--progress', '--parallel']
const IMAGE_PROGRAMS: Record<string, string> = { terraform: 'terraform', opentofu: 'tofu', tofu: 'tofu', terragrunt: 'terragrunt', 'aws-cli': 'aws' }
const XARGS_VALUES = ['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-lines',
  '--max-chars', '--delimiter', '--arg-file', '--process-slot-var', '-j', '--jobs']

// The commands one simple command hands to something that runs them: `bash -c '…'`, `eval …`,
// `ssh host …`, `xargs cmd`, `watch '…'`, `script -c '…'`, `find -exec … \;`, `docker exec c …`,
// `kubectl exec pod -- …`. Empty when it hands over none.
export function handedOver(argv: readonly string[]): string[] {
  const run = unwrap(argv)
  const name = program(run[0] ?? '')
  const args = run.slice(1)
  if (SHELLS.has(name)) {
    for (let i = 0; i < args.length; i += 1) {
      const a = nth(args, i)
      if (a === '-o' || a === '+o') i += 1
      else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return i + 1 < args.length ? [nth(args, i + 1)] : []
      else if (!a.startsWith('-') && !a.startsWith('+')) return []
    }
    return []
  }
  if (name === 'eval') return [args.join(' ')]
  if (name === 'script') {
    const at = args.indexOf('-c')
    return at >= 0 && at + 1 < args.length ? [nth(args, at + 1)] : []
  }
  if (name === 'ssh') {
    let i = 0
    while (i < args.length && nth(args, i).startsWith('-')) i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(nth(args, i)) ? 2 : 1
    return args.length > i + 1 ? [args.slice(i + 1).join(' ')] : []
  }
  if (name === 'watch') {
    let i = 0
    while (i < args.length && nth(args, i).startsWith('-')) i += /^-(n|d|-interval)$/.test(nth(args, i)) ? 2 : 1
    return args.length > i ? [args.slice(i).join(' ')] : []
  }
  if (name === 'xargs' || name === 'parallel') {
    const rest = afterOptions(args, XARGS_VALUES)
    return rest.length > 0 ? [rest.map(quote).join(' ')] : []
  }
  if (name === 'find') {
    const found: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(nth(args, i))) continue
      const end = args.findIndex((a, at) => at > i && (a === ';' || a === '+'))
      found.push(args.slice(i + 1, end < 0 ? args.length : end).map(quote).join(' '))
      i = end < 0 ? args.length : end
    }
    return found
  }
  if (name === 'kubectl' || name === 'oc') {
    const end = args.indexOf('--')
    return args.includes('exec') && end >= 0 && end + 1 < args.length ? [args.slice(end + 1).map(quote).join(' ')] : []
  }
  if (['docker', 'podman', 'nerdctl', 'docker-compose'].includes(name)) {
    // docker run IMAGE cmd, docker exec CONTAINER cmd, docker compose run|exec SERVICE cmd.
    let rest = afterOptions(args, CONTAINER_VALUES) // the global options, docker-compose's too
    if (rest[0] === 'compose' || rest[0] === 'container') rest = afterOptions(rest.slice(1), CONTAINER_VALUES)
    if (rest[0] !== 'run' && rest[0] !== 'exec') return []
    const [image, ...command] = afterOptions(rest.slice(1), CONTAINER_VALUES)
    // An image made to run one program runs it with the words after the image.
    const runs = rest[0] === 'run' ? own(IMAGE_PROGRAMS, program(image ?? '').replace(/[:@].*$/, '')) : undefined
    const words = runs !== undefined ? [runs, ...command] : command
    return words.length > 0 ? [words.map(quote).join(' ')] : []
  }
  return []
}

// The word at this place, or '' past the end.
function nth(list: readonly string[], at: number): string {
  return list[at] ?? ''
}

// A table's own entry, never one its prototype has (`constructor`).
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

function quote(word: string): string {
  return /^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}
