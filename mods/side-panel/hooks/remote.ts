// The remote section's plain logic: what is sent to the other machine over ssh, and how its answer
// and its failures read. One read-only call per refresh; nothing here runs anything.

import type { Line, Remote, RemoteSession, Run } from '../types'
import { lines } from './panel'
import { parse } from './runs'

export type { Remote, RemoteSession }

// How long the whole ssh call may take, enforced on this machine by `timeout`: a host that hangs
// (asleep, or Tailscale SSH waiting for a browser login, which BatchMode does not stop) ends here.
export const REMOTE_WAIT_S = 15

// The host setting: an ssh host or alias, nothing that ssh would read as an option.
export function remoteHost(setting: string): string {
  const host = setting.trim()
  return /^[A-Za-z0-9][\w.@-]*$/.test(host) ? host : ''
}

export function remoteArgv(host: string): string[] {
  return [
    'timeout', String(REMOTE_WAIT_S),
    'ssh', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '--', host, 'bash -l -s',
  ]
}

// The script the remote bash reads on stdin. Sessions: the ~/.claude/sessions files whose process is
// alive and is claude, each line its process's start time and the file; a file whose procStart is
// another start time belongs to an earlier process with the same pid. Runs: this mod's run files on
// that machine. Then the owner's own command, and its exit code.
export function remoteScript(command: string): string {
  return [
    'echo @@sessions',
    'for f in "$HOME"/.claude/sessions/*.json; do',
    '  [ -f "$f" ] || continue',
    '  p=${f##*/}; p=${p%.json}',
    "  case $p in ''|*[!0-9]*) continue ;; esac",
    '  [ "$(cat /proc/$p/comm 2>/dev/null)" = claude ] || continue',
    "  s=$(cut -d' ' -f22 /proc/$p/stat 2>/dev/null)",
    `  printf '%s %s\\n' "\${s:-0}" "$(tr -d '\\n' < "$f")"`,
    'done',
    'echo @@runs',
    'for f in "$HOME"/.local/state/side-panel/runs/*.json; do [ -f "$f" ] && { tr -d \'\\n\' < "$f"; echo; }; done',
    'echo @@sections',
    ...(command.trim() !== '' ? ['(', command, ')'] : ['true']),
    'echo "@@end $?"',
    '',
  ].join('\n')
}

type SessionFile = { pid?: number; name?: string; cwd?: string; status?: string; kind?: string; startedAt?: number; procStart?: string }

// The remote's answer. `cut` is set when the answer stopped before the script's end.
export function readAnswer(stdout: string): Pick<Remote, 'sessions' | 'runs' | 'lines' | 'note'> & { cut?: boolean } {
  const sessions: RemoteSession[] = []
  const runs: Run[] = []
  const sectionText: string[] = []
  let part = ''
  let end: number | undefined
  for (const line of stdout.split('\n')) {
    const marker = /^@@(sessions|runs|sections|end)(?: (\d+))?$/.exec(line.trim())
    if (marker) {
      part = marker[1] ?? ''
      if (part === 'end') end = Number(marker[2] ?? 0)
      continue
    }
    if (part === 'sessions') {
      const one = session(line)
      if (one) sessions.push(one)
    } else if (part === 'runs') {
      const run = parse(line)
      if (run) runs.push(run)
    } else if (part === 'sections') sectionText.push(line)
  }
  sessions.sort((a, b) => a.name.localeCompare(b.name))
  const shown: Line[] = lines(sectionText.join('\n'))
  return {
    sessions,
    runs,
    lines: shown,
    ...(end !== undefined && end !== 0 ? { note: `remote_sections: exit ${end}` } : {}),
    ...(end === undefined ? { cut: true } : {}),
  }
}

function session(line: string): RemoteSession | undefined {
  const m = /^(\d+) (\{.*\})\s*$/.exec(line)
  if (!m) return undefined
  try {
    const f = JSON.parse(m[2] ?? '') as SessionFile
    if (f.procStart !== undefined && f.procStart !== m[1]) return undefined
    const cwd = typeof f.cwd === 'string' ? f.cwd : ''
    const name = (typeof f.name === 'string' && f.name) || cwd.split('/').filter(Boolean).pop() || String(f.pid ?? '?')
    return {
      name,
      cwd,
      ...(typeof f.status === 'string' ? { status: f.status } : {}),
      ...(typeof f.kind === 'string' ? { kind: f.kind } : {}),
      ...(typeof f.startedAt === 'number' ? { started: f.startedAt } : {}),
    }
  } catch {
    return undefined
  }
}

// Why the remote could not be read, in words for the pane; undefined when the call worked.
// exitCode null: the call could not start or outlived this machine's own limit.
export function remoteError(host: string, ran: { exitCode: number | null; stdout: string; stderr: string }, cut: boolean): string | undefined {
  const first = ran.stderr.split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('#')) ?? ''
  if (/login\.tailscale\.com|Tailscale SSH requires/i.test(ran.stderr)) return `${host} waits for a Tailscale login: run \`ssh ${host} true\` in a terminal`
  if (ran.exitCode === 124 || ran.exitCode === null) return `${host} is not answering (asleep or off?)${ran.exitCode === null && first ? `: ${first}` : ''}`
  if (ran.exitCode === 255) return `${host}: ${first || 'ssh failed'}`
  if (ran.exitCode !== 0) return `${host}: exit ${ran.exitCode}${first ? `: ${first}` : ''}`
  if (cut) return `${host}: the answer stopped early`
  return undefined
}
