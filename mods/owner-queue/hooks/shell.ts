// A small reader of shell commands: it splits a command line into the simple commands a shell
// would run, each as its argument list with the quotes taken off, and it opens what runs inside
// others ($(…), backticks, subshells, heredocs read by a shell, unquoted heredocs' substitutions).
// It is not a full shell: it reads well-formed commands the way bash would, and anything it cannot
// read stays in the words, where the rules still see it.

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')'])

type Heredoc = { tag: string; isQuoted: boolean; argv: string[] }

// Every simple command the text runs, nested ones included, as argument lists.
export function commands(text: string, depth = 0): string[][] {
  if (depth > 8) return []
  const src = text.replace(/\\\r?\n/g, ' ') // line continuations join lines
  const out: string[][] = []
  let argv: string[] = []
  let word = ''
  let hasWord = false
  let pending: Heredoc[] = []
  let i = 0

  const endWord = () => {
    if (hasWord) argv.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (argv.length > 0) out.push(argv)
    argv = []
  }
  const nested = (inner: string) => out.push(...commands(inner, depth + 1))

  while (i < src.length) {
    const c = src[i]

    if (c === '\\' && i + 1 < src.length) {
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
        if (src[j] === '\\' && j + 1 < src.length) {
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
        pending.push({ tag: m[2], isQuoted: m[1] !== '', argv })
        i += m[0].length
      }
      continue
    }
    if (c === '>' || c === '<') {
      // A redirection: drop a file descriptor number written just before it, then its target.
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else endWord()
      i += 1
      while (src[i] === '>' || src[i] === '<' || src[i] === '&' || src[i] === '|') i += 1
      while (src[i] === ' ' || src[i] === '\t') i += 1
      while (i < src.length && !/[\s;&|()<>]/.test(src[i])) i += 1
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
        if (sameLine.some(readsCommands)) nested(body)
        else if (!doc.isQuoted) for (const inner of substitutions(body)) nested(inner)
      }
      pending = []
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

// The index of the ) that closes the ( at `open`, skipping quoted text.
function closing(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === '\\') i += 1
    else if (c === "'") i = Math.max(i, src.indexOf("'", i + 1))
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
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

export function program(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

// The argument list after assignments and wrappers (env, sudo, timeout 5, nohup …), so the program
// that really runs comes first.
export function unwrap(argv: readonly string[]): string[] {
  let rest = [...argv]
  for (let guard = 0; guard < 10 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1)
    const name = program(rest[0] ?? '')
    if (['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'builtin', 'nice', 'stdbuf', 'caffeinate'].includes(name)) {
      rest = rest.slice(1)
      while (rest.length > 0 && rest[0].startsWith('-')) rest = rest.slice(rest[0] === '-n' || rest[0] === '-u' ? 2 : 1)
      continue
    }
    if (name === 'timeout') {
      rest = rest.slice(1)
      while (rest.length > 0 && rest[0].startsWith('-')) rest = rest.slice(1)
      rest = rest.slice(1) // the duration
      continue
    }
    if (name === '{' || name === '!' || name === 'then' || name === 'do' || name === 'else') {
      rest = rest.slice(1)
      continue
    }
    break
  }
  return rest
}

// Whether a heredoc fed to this command is read as commands.
function readsCommands(argv: readonly string[]): boolean {
  const run = unwrap(argv)
  const name = program(run[0] ?? '')
  return SHELLS.has(name) || name === 'ssh' || name === 'eval' || name === 'source' || name === '.'
}

// The commands one simple command hands to something that runs them: `bash -c '…'`, `eval …`,
// `ssh host …`, `xargs cmd`, `watch '…'`, `script -c '…'`. Empty when it hands over none.
export function handedOver(argv: readonly string[]): string[] {
  const run = unwrap(argv)
  const name = program(run[0] ?? '')
  const args = run.slice(1)
  if (SHELLS.has(name)) {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]
      if (a === '-o' || a === '+o') i += 1
      else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return args[i + 1] !== undefined ? [args[i + 1]] : []
      else if (!a.startsWith('-') && !a.startsWith('+')) return []
    }
    return []
  }
  if (name === 'eval') return [args.join(' ')]
  if (name === 'script') {
    const at = args.indexOf('-c')
    return at >= 0 && args[at + 1] !== undefined ? [args[at + 1]] : []
  }
  if (name === 'ssh') {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[i]) ? 2 : 1
    return args.length > i + 1 ? [args.slice(i + 1).join(' ')] : []
  }
  if (name === 'watch') {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) i += /^-(n|d|-interval)$/.test(args[i]) ? 2 : 1
    return args.length > i ? [args.slice(i).join(' ')] : []
  }
  if (name === 'xargs' || name === 'parallel') {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) i += /^-[IdEsLnPa]$/.test(args[i]) ? 2 : 1
    return args.length > i ? [args.slice(i).map(quote).join(' ')] : []
  }
  return []
}

function quote(word: string): string {
  return /^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}
