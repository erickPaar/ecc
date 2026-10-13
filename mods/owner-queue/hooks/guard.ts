// Which commands only the owner runs. Each simple command the shell would run (shell.ts) is judged
// by its program and arguments, so spelling (quotes, continuations, paths, wrappers) does not
// matter. AWS is an allow-list of reads; everything else is a list of writes.

import { commands, handedOver, program, unwrap } from './shell'

// Why the model may not run this command, or undefined when it may. `extra` is the person's own
// regular expression from the plugin's settings, tested against each simple command as one line;
// an invalid one holds nothing more.
export function heldReason(command: string, extra = ''): string | undefined {
  let pattern: RegExp | undefined
  try {
    pattern = extra === '' ? undefined : new RegExp(extra)
  } catch {
    pattern = undefined
  }
  return judge(commands(command), pattern, 0)
}

function judge(list: readonly string[][], extra: RegExp | undefined, depth: number): string | undefined {
  for (const argv of list) {
    const run = unwrap(argv)
    if (run.length === 0) continue
    const why = rule(run) ?? (extra?.test(run.join(' ')) ? 'held by your settings' : undefined)
    if (why !== undefined) return why
    if (depth < 4) {
      for (const inner of handedOver(argv)) {
        const nested = judge(commands(inner), extra, depth + 1)
        if (nested !== undefined) return nested
      }
    }
  }
  return undefined
}

function rule(run: readonly string[]): string | undefined {
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
      return gitPush(args)
    case 'claude':
      return claude(args)
    default:
      return undefined
  }
}

const IAC_WRITES = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'refresh'])

function iac(args: readonly string[]): string | undefined {
  const words = args.filter(a => !a.startsWith('-'))
  const [first, second] = words
  if (IAC_WRITES.has(first)) return 'infrastructure change'
  if (first === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(second)) return 'infrastructure change'
  if ((first === 'run-all' || first === 'run') && words.slice(1).some(w => IAC_WRITES.has(w))) return 'infrastructure change'
  return undefined
}

// make's flags that take a value as the next word.
const MAKE_VALUE_FLAGS = new Set(['-C', '-f', '-I', '-o', '-W', '-j', '-l', '--directory', '--file', '--makefile'])

function make(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
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
const AWS_READ_WHOLE = new Set(['query', 'scan', 'wait', 'help', 'tail', 'login', 'logout'])
// Whole services that only read, or that the owner lets the model use (model calls).
const AWS_READ_SERVICES = new Set(['sts', 'sso', 'sso-oidc', 'configure', 'pricing', 'bedrock-runtime', 'history'])
// Single operations that read although their name does not say so.
const AWS_READ_OPS = new Set([
  'logs start-query', 'logs stop-query', 'logs start-live-tail', 'athena start-query-execution',
  'athena stop-query-execution', 'ecr get-login-password', 'ecr-public get-login-password',
  'events test-event-pattern', 'iam generate-service-last-accessed-details', 'iam generate-credential-report',
])
// s3 options that take a value, so their value is not taken for a source or destination.
const S3_VALUE_OPTIONS = new Set([
  '--exclude', '--include', '--acl', '--sse', '--sse-kms-key-id', '--sse-c', '--sse-c-key', '--content-type',
  '--storage-class', '--metadata', '--metadata-directive', '--cache-control', '--expires', '--grants',
  '--content-encoding', '--content-disposition', '--content-language', '--website-redirect',
  '--expected-size', '--source-region', '--page-size', '--checksum-algorithm',
])

function aws(args: readonly string[]): string | undefined {
  const words: string[] = []
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const a = args[i]
    if (AWS_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) words.push(a)
  }
  const [service, op] = words
  if (service === undefined) return undefined
  if (args.includes('help')) return undefined
  if (service === 's3') return s3(op, args.slice(args.indexOf(op) + 1))
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
    const a = rest[i]
    if (S3_VALUE_OPTIONS.has(a) || AWS_VALUE_OPTIONS.has(a)) i += 1
    else if (!a.startsWith('-')) positional.push(a)
  }
  if (op === 'cp' || op === 'sync') {
    // The destination is the last positional; a read copies from S3 to here, or to stdout (-).
    const destination = positional[positional.length - 1] ?? ''
    return positional.length >= 2 && destination.startsWith('s3://') ? 'upload to S3' : undefined
  }
  if (op === 'mv') return positional.some(p => p.startsWith('s3://')) ? 'destructive AWS call' : undefined
  return op === 'rm' || op === 'rb' ? 'destructive AWS call' : 'AWS write' // mb, website and the rest
}

// gh's options that take a value, before the subcommand or after it.
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])

function gh(args: readonly string[]): string | undefined {
  const words: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (GH_VALUE_OPTIONS.has(args[i])) i += 1
    else if (!args[i].startsWith('-')) words.push(args[i])
  }
  const [group, verb] = words
  if (group === 'workflow' && ['run', 'enable'].includes(verb)) return 'GitHub Actions run'
  if (group === 'run' && verb === 'rerun') return 'GitHub Actions run'
  if ((group === 'secret' || group === 'variable') && ['set', 'delete', 'remove'].includes(verb)) return 'GitHub repository settings'
  if (group === 'repo' && ['edit', 'delete', 'rename', 'archive', 'create'].includes(verb)) return 'GitHub repository settings'
  if (group === 'api') return ghApi(args.slice(args.indexOf('api') + 1))
  return undefined
}

const SETTINGS_PATH = /(^|\/)(protection|rulesets|collaborators|teams|hooks|secrets|variables|environments|keys|invitations|actions\/permissions|pages)(\/|$)|\/(dispatches|rerun|rerun-failed-jobs|approve)$/
// A PATCH that edits a pull request or an issue (its title or body) is ordinary work.
const EDITS_WORK = /^\/?repos\/[^/]+\/[^/]+\/(pulls|issues)(\/comments)?\/\d+$/

function ghApi(args: readonly string[]): string | undefined {
  let method = ''
  let hasFields = false
  let endpoint = ''
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase()
    else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase()
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase()
    else if (['-f', '-F', '--field', '--raw-field'].includes(a)) {
      hasFields = true
      values.push(args[++i] ?? '')
    } else if (a === '--input') {
      hasFields = true
      i += 1
    } else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(a)) i += 1
    else if (!a.startsWith('-') && endpoint === '') endpoint = a
  }
  if (method === '') method = hasFields ? 'POST' : 'GET'
  if (endpoint === 'graphql') return values.some(v => /\bmutation\b/.test(v)) ? 'GitHub API write' : undefined
  if (method === 'GET' || method === 'HEAD') return undefined
  if (method === 'PATCH' && EDITS_WORK.test(endpoint)) return undefined
  if (method === 'PUT' && /\/pulls\/\d+\/merge$/.test(endpoint)) return undefined // merges stay with the session
  if (method === 'POST') return SETTINGS_PATH.test(endpoint) ? 'GitHub API write' : undefined
  return 'GitHub API write'
}

// A push that updates main or master runs whatever applies on the default branch.
function gitPush(args: readonly string[]): string | undefined {
  const words: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C' || args[i] === '-c') i += 1
    else if (!args[i].startsWith('-')) words.push(args[i])
  }
  if (words[0] !== 'push') return undefined
  if (args.includes('--mirror')) return 'push to the default branch'
  const refs = words.slice(2)
  return refs.some(r => /(^|:|refs\/heads\/)(main|master)$/.test(r.replace(/^\+/, ''))) ? 'push to the default branch' : undefined
}

// Turning this guard (or any plugin) off is the owner's choice.
function claude(args: readonly string[]): string | undefined {
  const words = args.filter(a => !a.startsWith('-'))
  if (words[0] === 'plugin' && ['disable', 'uninstall', 'remove'].includes(words[1])) return 'plugin settings'
  if (words[0] === 'plugin' && words[1] === 'marketplace' && words[2] === 'remove') return 'plugin settings'
  return undefined
}
