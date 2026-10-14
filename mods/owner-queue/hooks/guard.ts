// Which commands only the owner runs. Each simple command the shell would run (shell.ts) is judged
// by its program and arguments, so spelling (quotes, continuations, paths, wrappers) does not
// matter. AWS is an allow-list of reads; everything else is a list of writes.

import { commands, handedOver, program, TooDeep, unwrap } from './shell'

// The current branch of each folder a push without a refspec runs in, as pushDirs named them;
// a folder missing here holds the push.
export type Branches = ReadonlyMap<string, string>

type Context = { extra: RegExp | undefined; branches: Branches; needs?: Set<string> }

const TOO_DEEP = 'command nested too deeply to read'

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
    return judge(commands(command), ctx, 0)
  } catch (error) {
    if (error instanceof TooDeep) return TOO_DEEP
    throw error
  }
}

// Programs worth judging again when they appear later in a command than its first word, for the
// wrappers the reader does not know (`mywrapper --flag tofu apply`): the name alone, or a path in a
// bin folder. Programs that print, list or test their words never run them, so they are not read so.
const HELD_PROGRAMS = new Set(['tofu', 'terraform', 'terragrunt', 'aws', 'gh', 'git'])
const ONLY_READS_WORDS = new Set(['echo', 'printf', 'which', 'type', 'whereis', 'hash', 'for', 'select', 'case', 'man',
  'ls', 'cat', 'grep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'test', '[', '[['])

function judge(list: readonly string[][], ctx: Context, depth: number): string | undefined {
  // Every folder a later command may run in: where the command starts, and each cd before it.
  const dirs = ['']
  for (const argv of list) {
    const run = unwrap(argv)
    if (run.length === 0) continue
    if (program(run[0]) === 'cd') dirs.push(join(dirs[dirs.length - 1] ?? '', run.slice(1).find(a => !a.startsWith('-') || a === '-') ?? '~'))
    const why = rule(run, dirs, ctx) ?? later(run, dirs, ctx) ?? (ctx.extra?.test(run.join(' ')) ? 'held by your settings' : undefined)
    if (why !== undefined) return why
    for (const inner of handedOver(argv)) {
      if (depth >= 4) return TOO_DEEP
      const nested = judge(commands(inner), ctx, depth + 1)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function later(run: readonly string[], dirs: readonly string[], ctx: Context): string | undefined {
  if (ONLY_READS_WORDS.has(program(run[0]))) return undefined
  for (let i = 1; i < run.length; i += 1) {
    const word = run[i] ?? ''
    const isProgram = HELD_PROGRAMS.has(word) || (HELD_PROGRAMS.has(program(word)) && /(^|\/)bin\/[^/]+$/.test(word))
    if (!isProgram) continue
    const why = rule(run.slice(i), dirs, ctx)
    if (why !== undefined) return why
  }
  return undefined
}

function rule(run: readonly string[], dirs: readonly string[], ctx: Context): string | undefined {
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
      return gitPush(args, dirs, ctx)
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
  if ((first === 'run-all' || first === 'run') && words.slice(1).some(w => IAC_WRITES.has(w))) return 'infrastructure change'
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
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const a = args[i] ?? ''
    if (AWS_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) words.push(a)
  }
  const [service, op] = words
  if (service === undefined) return undefined
  // `help` prints help as the service, the operation or the last word; anywhere else it is a value.
  const last = args.length - 1
  if (args[last] === 'help' && last > 0 && !(args[last - 1] ?? '-').startsWith('-')) return undefined
  if (service === 's3') return s3(op, args.slice(args.indexOf(op ?? '') + 1))
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
  /(^|\/)(protection|rulesets|collaborators|teams|hooks|secrets|variables|environments|keys|invitations|actions\/permissions|pages|statuses|check-runs)(\/|$)|\/(dispatches|rerun|rerun-failed-jobs|approve|pending_deployments|transfer)$/
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
    // A query read from a file (query=@f.graphql, --input) may be a mutation the guard cannot see.
    const isWrite = hasInput || values.some(v => /\bmutation\b/.test(v) || /^query=@/.test(v))
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

// A push that updates main or master runs whatever applies on the default branch. A push with no
// refspec, or of HEAD or @, pushes the current branch, read in each folder the command may run in.
function gitPush(args: readonly string[], dirs: readonly string[], ctx: Context): string | undefined {
  let at = ''
  let i = 0
  for (; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '-C') at = join(at, args[i + 1] ?? '')
    if (GIT_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) break
  }
  if (args[i] !== 'push') return undefined
  const words: string[] = []
  for (let j = i + 1; j < args.length; j += 1) {
    const a = args[j] ?? ''
    if (a === '--all' || a === '--mirror' || a === '--branches') return 'push to the default branch'
    if (PUSH_VALUE_OPTIONS.has(a)) j += 1
    else if (!a.startsWith('-')) words.push(a)
  }
  const refs = words.slice(1).map(r => r.replace(/^\+/, ''))
  if (refs.some(r => /(^|:|refs\/heads\/)(main|master)$/.test(r))) return 'push to the default branch'
  if (refs.length > 0 && !refs.some(r => r === 'HEAD' || r === '@')) return undefined
  for (const dir of dirs) {
    const key = join(dir, at)
    if (ctx.needs !== undefined) ctx.needs.add(key)
    else if (!ctx.branches.has(key)) return 'push from a branch the guard could not read'
    else if (DEFAULT_BRANCH.test(ctx.branches.get(key) ?? '')) return 'push to the default branch'
  }
  return undefined
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
