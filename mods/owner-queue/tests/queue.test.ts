import { describe, expect, test } from 'claude-code/testing'

import type { Item } from '../types'
import { blocker, canMark, ID, marker, newId, newNonce, stale, visible, waitingFor, withMarker } from '../hooks/queue'

describe('markers', () => {
  test('a copied command runs with pipefail, then prints its nonce and exit code', () => {
    expect(withMarker({ id: 'abc123', command: 'make apply STACK=network | tee log' }, 'n0nce')).toBe(
      '(set -o pipefail; make apply STACK=network | tee log); echo "oq:abc123:n0nce:$?"',
    )
  })
  test('the marker counts only as the last line of standard output', () => {
    expect(marker('<bash-stdout>Apply complete!\noq:abc123:n0:0\n</bash-stdout><bash-stderr></bash-stderr>')).toEqual({ id: 'abc123', nonce: 'n0', code: 0 })
    expect(marker('<bash-stdout>oq:abc123:n0:2</bash-stdout>')).toEqual({ id: 'abc123', nonce: 'n0', code: 2 })
    expect(marker('<bash-stdout>oq:abc123:n0:0\nmore output</bash-stdout>')).toBeUndefined()
    expect(marker('<bash-stdout>echo oq:abc123:n0:0 printed</bash-stdout>')).toBeUndefined()
    expect(marker('<bash-stderr>oq:abc123:n0:0</bash-stderr>')).toBeUndefined()
    expect(marker('oq:abc123:n0:0')).toBeUndefined()
  })
  test('a marker without a nonce is no marker', () => {
    expect(marker('<bash-stdout>oq:abc123:0</bash-stdout>')).toBeUndefined()
  })
  test('a command a marker would break gets none', () => {
    for (const command of ['make apply # network', 'sleep 1 &', 'a;', '', 'a\nb']) {
      expect(canMark(command)).toBe(false)
      expect(withMarker({ id: 'x', command }, 'n')).toBe(command)
    }
  })
  test('nonces are long, random and fit the marker', () => {
    const [a, b] = [newNonce(), newNonce()]
    expect(a).toMatch(/^[a-z0-9]{16}$/)
    expect(a).not.toBe(b)
  })
})

const item = (id: string, fields: Partial<Item> = {}): Item => ({
  id, command: `run ${id}`, why: id, from: 's', status: 'waiting', created: 1, updated: 1, ...fields,
})

describe('order', () => {
  test('an item waits until the one before it is done', () => {
    const first = item('a')
    const second = item('b', { after: 'a', created: 2 })
    expect(blocker(second, [first, second])?.id).toBe('a')
    expect(blocker(second, [{ ...first, status: 'failed' }, second])?.id).toBe('a')
    expect(blocker(second, [{ ...first, status: 'done' }, second])).toBeUndefined()
    expect(blocker(second, [{ ...first, status: 'removed' }, second])).toBeUndefined()
    expect(blocker(second, [second])).toBeUndefined()
  })
  test('the pane lists what is open and what finished in the last hour, in order', () => {
    const now = 10_000_000
    const list = [
      item('old', { status: 'done', updated: now - 3_600_001, created: 1 }),
      item('new', { status: 'done', updated: now - 10, created: 2 }),
      item('gone', { status: 'removed', created: 3 }),
      item('fail', { status: 'failed', created: 4 }),
      item('wait', { created: 5 }),
    ]
    expect(visible(list, now).map(one => one.id)).toEqual(['new', 'fail', 'wait'])
  })
  test('files of items removed or done over a day ago are stale; open ones never', () => {
    const now = 200_000_000
    const list = [
      item('a', { status: 'removed', updated: now - 86_400_001 }),
      item('b', { status: 'done', updated: now - 86_400_001 }),
      item('c', { status: 'done', updated: now - 10 }),
      item('d', { status: 'waiting', updated: 0 }),
      item('e', { status: 'failed', updated: 0 }),
    ]
    expect(stale(list, now).map(one => one.id)).toEqual(['a', 'b'])
  })
  test('ids differ within the same millisecond', () => {
    const now = 1_791_913_383_175
    expect(newId(now, 0.1)).not.toBe(newId(now, 0.2))
    expect(newId(now, 0.1)).toMatch(/^[a-z0-9]{8}$/)
  })
  test('an id is a plain word, never a path', () => {
    expect(ID.test('abc123')).toBe(true)
    for (const id of ['../x', 'a/b', 'A1', '', 'a.json']) expect(ID.test(id)).toBe(false)
  })
  test('the same command waiting already is found, whatever its why', () => {
    const list = [item('a', { command: 'tofu apply' }), item('b', { command: '', why: 'approve the release' })]
    expect(waitingFor(list, { command: 'tofu apply', why: 'again' })?.id).toBe('a')
    expect(waitingFor(list, { command: '', why: 'approve the release' })?.id).toBe('b')
    expect(waitingFor(list, { command: '', why: 'another decision' })).toBeUndefined()
    expect(waitingFor([item('a', { command: 'tofu apply', status: 'done' })], { command: 'tofu apply', why: 'x' })).toBeUndefined()
  })
})
