import { describe, expect, test } from 'claude-code/testing'

import { readAnswer, remoteArgv, remoteError, remoteHost, remoteScript } from '../hooks/remote'

const session = (start: string, file: object) => `${start} ${JSON.stringify(file)}`
const RUN = { session: 'api', id: 'a1', label: 'run a1', type: 'general-purpose', isBackground: true, started: 1, status: 'running' }

describe('the host setting', () => {
  test('a host or an alias passes; anything ssh would read as an option or a command does not', () => {
    expect(remoteHost(' desk ')).toBe('desk')
    expect(remoteHost('me@desk.tail-net.ts.net')).toBe('me@desk.tail-net.ts.net')
    expect(remoteHost('-oProxyCommand=x')).toBe('')
    expect(remoteHost('desk; rm -rf ~')).toBe('')
    expect(remoteHost('')).toBe('')
  })
  test('ssh never asks, gives up on a dead link, and the whole call is bounded on this machine', () => {
    const argv = remoteArgv('desk')
    expect(argv.slice(0, 3)).toEqual(['timeout', '15', 'ssh'])
    expect(argv).toContain('BatchMode=yes')
    expect(argv.slice(-3)).toEqual(['--', 'desk', 'bash -l -s'])
  })
})

describe('the script', () => {
  test('reads sessions, runs, then the command, and ends with its exit code', () => {
    const script = remoteScript('list-jobs')
    const at = (s: string) => script.indexOf(s)
    expect(at('@@sessions')).toBeLessThan(at('@@runs'))
    expect(at('@@runs')).toBeLessThan(at('@@sections'))
    expect(at('@@sections')).toBeLessThan(at('list-jobs'))
    expect(script).toContain('echo "@@end $?"')
    expect(script).toContain('/proc/$p/comm')
  })
  test('with no command it still ends cleanly', () => {
    expect(remoteScript('  ')).toContain('true\necho "@@end $?"')
  })
})

describe('reading the answer', () => {
  test('sessions by name; a file whose procStart is another process\'s start is skipped', () => {
    const out = [
      'motd noise before the first marker',
      '@@sessions',
      session('500', { pid: 9, name: 'zeta', cwd: '/w/z', status: 'idle', kind: 'interactive', startedAt: 10, procStart: '500' }),
      session('777', { pid: 8, name: 'old', cwd: '/w/o', procStart: '123' }),
      session('600', { pid: 7, cwd: '/home/x/projects/api', status: 'busy' }),
      'not a session line',
      '@@runs',
      JSON.stringify(RUN),
      '{"half":',
      '@@sections',
      '## rc',
      '⠋ job-1 · make check',
      '@@end 0',
    ].join('\n')
    const a = readAnswer(out)
    expect(a.sessions.map(s => s.name)).toEqual(['api', 'zeta'])
    expect(a.sessions[1]).toMatchObject({ status: 'idle', kind: 'interactive', started: 10 })
    expect(a.runs.map(r => r.id)).toEqual(['a1'])
    expect(a.lines).toEqual([{ kind: 'heading', text: 'rc' }, { kind: 'text', text: '⠋ job-1 · make check', tone: 'blue' }])
    expect(a.note).toBeUndefined()
    expect(a.cut).toBeUndefined()
  })
  test('the command\'s failure is a note; an answer without its end is cut', () => {
    expect(readAnswer('@@sessions\n@@runs\n@@sections\n@@end 3\n').note).toBe('remote_sections: exit 3')
    expect(readAnswer('@@sessions\n@@runs\n').cut).toBe(true)
  })
})

describe('why it could not be read', () => {
  const ok = { exitCode: 0, stdout: '', stderr: '' }
  test('a Tailscale SSH check waiting in the browser says what to run', () => {
    const stderr = '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/x\n'
    expect(remoteError('desk', { exitCode: 124, stdout: '', stderr }, true)).toBe('desk waits for a Tailscale login: run `ssh desk true` in a terminal')
  })
  test('a timeout is "not answering"; ssh\'s own failure is its first line', () => {
    expect(remoteError('desk', { exitCode: 124, stdout: '', stderr: '' }, true)).toBe('desk is not answering (asleep or off?)')
    expect(remoteError('desk', { exitCode: null, stdout: '', stderr: 'timed out after 25000 ms' }, true)).toBe('desk is not answering (asleep or off?): timed out after 25000 ms')
    expect(remoteError('desk', { exitCode: 255, stdout: '', stderr: 'ssh: Could not resolve hostname desk\n' }, true)).toBe('desk: ssh: Could not resolve hostname desk')
    expect(remoteError('desk', { exitCode: 1, stdout: '', stderr: 'bash: no\n' }, true)).toBe('desk: exit 1: bash: no')
  })
  test('a clean answer is no error; a clean exit with a cut answer is one', () => {
    expect(remoteError('desk', ok, false)).toBeUndefined()
    expect(remoteError('desk', ok, true)).toBe('desk: the answer stopped early')
  })
})
