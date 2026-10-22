// Which commands only the owner runs. Each simple command the shell would run (shell.ts) is judged
// by its program and arguments, so spelling (quotes, continuations, paths, wrappers) does not
// matter. AWS is an allow-list of reads; everything else is a list of writes.
//
// A best effort, not an integrity boundary: it catches the ways a model writes these commands by
// accident, and the README lists what it does not see. The account's permissions are the control.

import { commands, handedOver, program, runsElsewhere, TooDeep, Unclosed, unwrap } from './shell'

// The current branch of each folder a push without a refspec runs in, as pushDirs named them;
// a folder missing here holds the push.
export type Branches = ReadonlyMap<string, string>

type Context = { extra: RegExp | undefined; branches: Branches; needs?: Set<string> }

// What one command has done so far, read in order: every folder a later command may run in (where
// it starts, and each cd or pushd), and what each folder's branch may be after a checkout or switch
// (READ is the branch git reads there; UNKNOWN a switch the guard cannot name).
type State = { dirs: string[]; switched: Map<string, string[]> }
const READ = ':read'
const UNKNOWN = ':unknown'

const TOO_DEEP = 'command nested too deeply to read'
const UNREADABLE = 'command the guard could not read'
const DEFAULT_PUSH = 'push to the default branch'
const UNREAD_PUSH = 'push from a branch the guard could not read'

// Why the model may not run this command, or undefined when it may. `extra` is the person's own
// regular expression from the plugin's settings, tested against each simple command as one line;
// an invalid one holds nothing more.
export function heldReason(command: string, extra = '', branches: Branches = new Map()): string | undefined {
  let pattern: RegExp | undefined
  try {
    pattern = extra === '' ? undefined : new RegExp(extra)
  } catch {
    pattern = undefined
  }
  return read(command, { extra: pattern, branches })
}

// The folders whose current branch a push in this command needs ('' is the session's own), so the
// caller can read them before heldReason.
export function pushDirs(command: string): string[] {
  const needs = new Set<string>()
  read(command, { extra: undefined, branches: new Map(), needs })
  return [...needs]
}

function read(command: string, ctx: Context): string | undefined {
  try {
    return judge(commands(command), ctx, 0, { dirs: [''], switched: new Map() })
  } catch (error) {
    if (error instanceof TooDeep) return TOO_DEEP
    if (error instanceof Unclosed) return UNREADABLE
    throw error
  }
}

// Programs worth judging again when they appear later in a command than its first word, for the
// wrappers the reader does not know (`mywrapper --flag tofu apply`): the name alone, or a path in a
// bin folder. Programs that print, list or test their words never run them, so they are not read so.
const HELD_PROGRAMS = new Set(['tofu', 'terraform', 'terragrunt', 'aws', 'gh', 'git'])
const ONLY_READS_WORDS = new Set(['echo', 'printf', 'which', 'type', 'whereis', 'hash', 'for', 'select', 'case', 'man',
  'ls', 'cat', 'grep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'test', '[', '[['])

// What runs inside a command (bash -c, ssh …) is read with the same state: it runs after what came
// before it, in the same folders.
function judge(list: readonly string[][], ctx: Context, depth: number, state: State): string | undefined {
  for (const argv of list) {
    const run = unwrap(argv)
    if (run.length === 0) continue
    const { dirs } = state
    if (['cd', 'pushd'].includes(program(run[0]))) dirs.push(join(dirs[dirs.length - 1] ?? '', run.slice(1).find(a => !a.startsWith('-') || a === '-') ?? '~'))
    const where = { state, isElsewhere: runsElsewhere(argv) }
    const why = rule(run, where, ctx) ?? later(run, where, ctx) ?? (ctx.extra?.test(run.join(' ')) ? 'held by your settings' : undefined)
    if (why !== undefined) return why
    for (const inner of handedOver(argv)) {
      if (depth >= 4) return TOO_DEEP
      const nested = judge(commands(inner), ctx, depth + 1, state)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

// Where a simple command runs: the command's state, and whether a wrapper moved it elsewhere.
type Where = { state: State; isElsewhere: boolean }

function later(run: readonly string[], where: Where, ctx: Context): string | undefined {
  if (ONLY_READS_WORDS.has(program(run[0]))) return undefined
  for (let i = 1; i < run.length; i += 1) {
    const word = run[i] ?? ''
    const isProgram = HELD_PROGRAMS.has(word) || (HELD_PROGRAMS.has(program(word)) && /(^|\/)bin\/[^/]+$/.test(word))
    if (!isProgram) continue
    const why = rule(run.slice(i), where, ctx)
    if (why !== undefined) return why
  }
  return undefined
}

function rule(run: readonly string[], where: Where, ctx: Context): string | undefined {
  const name = program(run[0])
  const args = run.slice(1)
  switch (name) {
    case 'tofu':
    case 'terraform':
    case 'terragrunt':
      return iac(args)
    case 'make':
      return make(args)
    case 'aws':
      return aws(args)
    case 'gh':
      return gh(args)
    case 'git':
      return git(args, where, ctx)
    case 'claude':
      return claude(args)
    default:
      return undefined
  }
}

const IAC_WRITES = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'refresh', 'apply-all', 'destroy-all'])

function iac(args: readonly string[]): string | undefined {
  if (args.some(a => a === '-help' || a === '--help' || a === '-h')) return undefined // prints the command's help
  const words = args.filter(a => !a.startsWith('-'))
  const [first = '', second = ''] = words
  if (IAC_WRITES.has(first)) return 'infrastructure change'
  if (first === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(second)) return 'infrastructure change'
  if (first === 'workspace' && second === 'delete') return 'infrastructure change'
  // terragrunt run-all apply, run --all apply, stack run apply
  const at = first === 'stack' ? 1 : 0
  if (['run-all', 'run'].includes(words[at] ?? '') && words.slice(at + 1).some(w => IAC_WRITES.has(w))) return 'infrastructure change'
  return undefined
}

// make's flags that take a value as the next word (-j and -l take a number, never a target).
const MAKE_VALUE_FLAGS = new Set(['-C', '-f', '-I', '-o', '-W', '--directory', '--file', '--makefile'])
const MAKE_DRY_RUN = new Set(['-n', '--dry-run', '--just-print', '--recon'])

function make(args: readonly string[]): string | undefined {
  if (args.some(a => MAKE_DRY_RUN.has(a))) return undefined // prints the recipes, runs none
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (MAKE_VALUE_FLAGS.has(a)) i += 1
    else if (!a.startsWith('-') && ['apply', 'destroy', 'import'].includes(a)) return 'infrastructure change'
  }
  return undefined
}

// aws's global options that take a value as the next word.
const AWS_VALUE_OPTIONS = new Set([
  '--profile', '--region', '--output', '--query', '--endpoint-url', '--color', '--ca-bundle',
  '--cli-read-timeout', '--cli-connect-timeout', '--cli-binary-format', '--cli-input-json',
  '--cli-input-yaml', '--page-size', '--max-items', '--starting-token',
])
// Operations that only read, by prefix or whole name.
const AWS_READ_PREFIXES = ['get-', 'list-', 'describe-', 'head-', 'batch-get-', 'lookup-', 'search-', 'filter-', 'validate-', 'estimate-', 'preview-', 'simulate-', 'decode-', 'admin-get-', 'admin-list-']
const AWS_READ_WHOLE = new Set(['query', 'scan', 'wait', 'tail', 'login', 'logout'])
// Whole services that only read, or that the owner lets the model use (model calls).
const AWS_READ_SERVICES = new Set(['sts', 'sso', 'sso-oidc', 'configure', 'pricing', 'bedrock-runtime', 'history'])
// Single operations that read (or write only local files) although their name does not say so.
const AWS_READ_OPS = new Set([
  'logs start-query', 'logs stop-query', 'logs start-live-tail', 'athena start-query-execution',
  'athena stop-query-execution', 'ecr get-login-password', 'ecr-public get-login-password',
  'events test-event-pattern', 'iam generate-service-last-accessed-details', 'iam generate-credential-report',
  'eks update-kubeconfig',
])
// s3 options that take a value, so their value is not taken for a source or destination.
const S3_VALUE_OPTIONS = new Set([
  '--exclude', '--include', '--acl', '--sse', '--sse-kms-key-id', '--sse-c', '--sse-c-key', '--content-type',
  '--storage-class', '--metadata', '--metadata-directive', '--cache-control', '--expires', '--grants',
  '--content-encoding', '--content-disposition', '--content-language', '--website-redirect',
  '--expected-size', '--source-region', '--page-size', '--checksum-algorithm', '--request-payer', '--copy-props',
  '--checksum-mode', '--sse-c-copy-source', '--sse-c-copy-source-key',
])

function aws(args: readonly string[]): string | undefined {
  const words: string[] = []
  let opAt = args.length
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const a = args[i] ?? ''
    if (AWS_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) {
      words.push(a)
      opAt = i
    }
  }
  const [service, op] = words
  if (service === undefined) return undefined
  // `help` prints help as the service, the operation or the word right after it; anywhere else it
  // may be an option's value (`--names p1 help` deletes p1 and help).
  if (service === 'help' || op === 'help' || args[opAt + 1] === 'help') return undefined
  if (service === 's3') return s3(op, args.slice(opAt + 1))
  if (AWS_READ_SERVICES.has(service)) return undefined
  if (op === undefined) return undefined
  if (AWS_READ_WHOLE.has(op) || AWS_READ_PREFIXES.some(p => op.startsWith(p))) return undefined
  if (AWS_READ_OPS.has(`${service} ${op}`)) return undefined
  return /^(delete|terminate|remove|deregister|purge|revoke|disable|schedule-key-deletion|batch-delete)/.test(op)
    ? 'destructive AWS call'
    : 'AWS write'
}

function s3(op: string | undefined, rest: readonly string[]): string | undefined {
  if (op === undefined || op === 'ls' || op === 'presign') return undefined
  const positional: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? ''
    if (S3_VALUE_OPTIONS.has(a) || AWS_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) positional.push(a)
  }
  if (op === 'cp' || op === 'sync') {
    // The destination is the second positional; an option's value the list above does not know
    // comes after it, or before the source, so any S3 path after the first counts. A read copies
    // from S3 to here, or to stdout (-).
    return positional.slice(1).some(p => p.startsWith('s3://')) ? 'upload to S3' : undefined
  }
  if (op === 'mv') return positional.some(p => p.startsWith('s3://')) ? 'destructive AWS call' : undefined
  return op === 'rm' || op === 'rb' ? 'destructive AWS call' : 'AWS write' // mb, website and the rest
}

// gh's options that take a value, before the subcommand, between it and its verb, or after it.
const GH_VALUE_OPTIONS = new Set([
  '-R', '--repo', '--hostname', '-e', '--env', '-o', '--org', '-u', '--user', '-a', '--app', '-r', '--ref',
  '-b', '--body', '-f', '--field', '-F', '--raw-field', '--env-file', '-v', '--visibility', '--repos',
  '-q', '--jq', '-t', '--template', '--json', '-L', '--limit',
])

function gh(args: readonly string[]): string | undefined {
  const words: string[] = []
  for (let i = 0; i < args.length && words[0] !== 'api'; i += 1) {
    const a = args[i] ?? ''
    if (GH_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) words.push(a)
  }
  const [group = '', verb = '', object = ''] = words
  if (args.includes('--help') || args.includes('-h')) return undefined // prints the command's help
  if (group === 'workflow' && ['run', 'enable'].includes(verb)) return 'GitHub Actions run'
  if (group === 'run' && verb === 'rerun') return 'GitHub Actions run'
  if ((group === 'secret' || group === 'variable') && ['set', 'delete', 'remove'].includes(verb)) return 'GitHub repository settings'
  if (group === 'repo' && ['edit', 'delete', 'rename', 'archive', 'create'].includes(verb)) return 'GitHub repository settings'
  if (group === 'repo' && verb === 'deploy-key' && ['add', 'delete'].includes(object)) return 'GitHub repository settings'
  if (group === 'api') return ghApi(args.slice(args.indexOf('api') + 1))
  return undefined
}

const SETTINGS_PATH =
  /(^|\/)(protection|rulesets|collaborators|teams|hooks|secrets|variables|environments|keys|invitations|actions\/permissions|pages|statuses|check-runs|deployments)(\/|$)|\/(dispatches|rerun|rerun-failed-jobs|approve|pending_deployments|transfer)$/
// A PATCH that edits a pull request or an issue (its title or body) is ordinary work, and so is
// deleting a comment.
const EDITS_WORK = /^\/?repos\/[^/]+\/[^/]+\/(pulls|issues)(\/comments)?\/\d+$/
const COMMENT = /^\/?repos\/[^/]+\/[^/]+\/((pulls|issues)\/)?comments\/\d+$/
const MERGE = /^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/

function ghApi(args: readonly string[]): string | undefined {
  let method = ''
  let hasFields = false
  let hasInput = false
  let endpoint = ''
  const values: string[] = []
  const field = (value: string) => {
    hasFields = true
    values.push(value)
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase()
    else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase()
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase()
    else if (['-f', '-F', '--field', '--raw-field'].includes(a)) field(args[++i] ?? '')
    else if (/^-[fF]./.test(a)) field(a.slice(2))
    else if (/^--(field|raw-field)=/.test(a)) field(a.slice(a.indexOf('=') + 1))
    else if (a === '--input' || a.startsWith('--input=')) {
      hasFields = true
      hasInput = true
      if (a === '--input') i += 1
    } else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(a)) i += 1
    else if (!a.startsWith('-') && endpoint === '') endpoint = a
  }
  if (method === '') method = hasFields ? 'POST' : 'GET'
  if (endpoint === 'graphql') {
    // A query read from a file (query=@f.graphql, --input) or computed (query="$(cat f)", query="$Q")
    // may be a mutation the guard cannot see.
    const isWrite = hasInput || values.some(v => /\bmutation\b/.test(v) || /^query=(@|\$\{?\w+\}?$|.*\$\()/s.test(v))
    return isWrite ? 'GitHub API write' : undefined
  }
  if (method === 'GET' || method === 'HEAD') return undefined
  if (method === 'PATCH' && EDITS_WORK.test(endpoint)) return undefined
  if (method === 'DELETE' && COMMENT.test(endpoint)) return undefined
  if (method === 'PUT' && MERGE.test(endpoint)) return undefined // merges stay with the session
  if (method === 'POST') return SETTINGS_PATH.test(endpoint) ? 'GitHub API write' : undefined
  return 'GitHub API write'
}

// git's options before the subcommand that take a value; push's own.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const DEFAULT_BRANCH = /^(main|master)$/
// A refspec's destination that names the default branch, as git reads it (main, heads/main,
// refs/heads/main); feat/main is another branch.
const DEFAULT_REF = /^(refs\/)?(heads\/)?(main|master)$/
// A refspec that is the current branch: HEAD, @, or a substitution that prints its name.
const CURRENT_REF = /^(HEAD|@|\$\(git (branch --show-current|rev-parse --abbrev-ref HEAD|symbolic-ref --short HEAD)\))$/

// git: a push that updates main or master runs whatever applies on the default branch; a checkout
// or switch changes the branch a later push in the same folder pushes.
function git(args: readonly string[], where: Where, ctx: Context): string | undefined {
  let at = ''
  let isElsewhere = where.isElsewhere
  let i = 0
  for (; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '-C') at = join(at, args[i + 1] ?? '')
    if (/^--(git-dir|work-tree)(=|$)/.test(a)) isElsewhere = true
    if (GIT_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) break
  }
  const keys = where.state.dirs.map(dir => join(dir, at))
  const sub = args[i] ?? ''
  const rest = args.slice(i + 1)
  if ((sub === 'checkout' || sub === 'switch') && !isElsewhere) {
    const to = switchTarget(sub, rest)
    if (to === undefined) return undefined
    for (const key of keys) {
      const before = where.state.switched.get(key) ?? [READ]
      where.state.switched.set(key, to.isCertain ? [to.branch] : [...before, to.branch])
    }
    return undefined
  }
  return sub === 'push' ? push(rest, keys, where.state, ctx, isElsewhere) : undefined
}

// A push with no refspec, or of the current branch, pushes the branch each folder it may run in is
// on: read by git, or switched to earlier in the command.
function push(args: readonly string[], keys: readonly string[], state: State, ctx: Context, isElsewhere: boolean): string | undefined {
  const words: string[] = []
  for (let j = 0; j < args.length; j += 1) {
    const a = args[j] ?? ''
    if (a === '--all' || a === '--mirror' || a === '--branches') return DEFAULT_PUSH
    if (PUSH_VALUE_OPTIONS.has(a)) j += 1
    else if (!a.startsWith('-')) words.push(a)
  }
  let isCurrent = words.length <= 1
  for (const ref of words.slice(1)) {
    const spec = ref.replace(/^\+/, '')
    if (spec === ':' || spec.includes('*')) return DEFAULT_PUSH // matching branches, or a pattern
    const colon = spec.indexOf(':')
    const destination = colon < 0 ? spec : spec.slice(colon + 1) || spec.slice(0, colon) // main: is main
    if (CURRENT_REF.test(destination)) isCurrent = true
    else if (destination.includes('$')) return UNREAD_PUSH // a variable or a substitution
    else if (DEFAULT_REF.test(destination)) return DEFAULT_PUSH
  }
  if (!isCurrent) return undefined
  if (isElsewhere) return UNREAD_PUSH
  for (const key of keys) {
    for (const maybe of state.switched.get(key) ?? [READ]) {
      if (maybe === READ && ctx.needs !== undefined) ctx.needs.add(key)
      if (ctx.needs !== undefined) continue
      const branch = maybe === READ ? ctx.branches.get(key) : maybe
      if (branch === undefined || branch === UNKNOWN) return UNREAD_PUSH
      if (DEFAULT_BRANCH.test(branch)) return DEFAULT_PUSH
    }
  }
  return undefined
}

// The branch a checkout or switch moves to: certain for a new branch and for switch, which only
// switches branches; one more possibility for checkout of one word, which may be a file; UNKNOWN
// when the guard cannot name it. Undefined when it switches nothing (a checkout of paths).
function switchTarget(sub: string, args: readonly string[]): { branch: string; isCertain: boolean } | undefined {
  const creates = sub === 'switch' ? ['-c', '-C', '--create', '--force-create', '--orphan'] : ['-b', '-B', '--orphan']
  const named = (name: string, isCertain: boolean) =>
    name === '' || name === '-' || name.includes('$') ? { branch: UNKNOWN, isCertain: true } : { branch: name, isCertain }
  const words: string[] = []
  for (let j = 0; j < args.length; j += 1) {
    const a = args[j] ?? ''
    const create = creates.find(o => a === o || a.startsWith(o.startsWith('--') ? `${o}=` : o))
    if (create !== undefined) return named(a === create ? (args[j + 1] ?? '') : a.slice(create.length).replace(/^=/, ''), true)
    if (a === '--detach' || (sub === 'switch' && a === '-d')) return { branch: UNKNOWN, isCertain: true }
    if (a === '--') {
      if (j + 1 < args.length) return undefined // paths follow
      break
    }
    if (!a.startsWith('-') || a === '-') words.push(a)
  }
  if (words.length !== 1) return undefined // nothing to switch to, or a tree and paths
  return named(words[0] ?? '', sub === 'switch')
}

// A folder relative to another: '' is the session's own.
function join(base: string, dir: string): string {
  if (dir === '' || dir === '.') return base
  if (base === '' || dir.startsWith('/') || dir.startsWith('~')) return dir
  return `${base}/${dir}`
}

// Turning this guard (or any plugin) off is the owner's choice.
function claude(args: readonly string[]): string | undefined {
  const [first = '', second = '', third = ''] = args.filter(a => !a.startsWith('-'))
  if (first !== 'plugin' && first !== 'plugins') return undefined
  if (['disable', 'uninstall', 'remove'].includes(second)) return 'plugin settings'
  if (second === 'marketplace' && third === 'remove') return 'plugin settings'
  return undefined
}
