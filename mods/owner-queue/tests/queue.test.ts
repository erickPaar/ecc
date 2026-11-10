import { describe, expect, test } from 'claude-code/testing'

import type { Item } from '../types'
import {
  age, blocker, canMark, fold, heldReason, ID, isKind, kindOf, listing, marker, newId, newNonce, nextItem, numberOf, stale, summary, visible,
  waitingFor, withMarker,
} from '../hooks/queue'

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
      item('gone', { status: 'removed', created: 3, updated: now - 10 }),
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

describe('0.3: what the pane and the list show', () => {
  const now = 10_000_000
  test('removed by a session shows for an hour; removed or cleared by the owner, or before 0.3.0, never', () => {
    const list = [
      item('bysession', { status: 'removed', by: 'api-design', note: 'dup', updated: now - 10, created: 1 }),
      item('byowner', { status: 'removed', by: 'owner', hidden: true, updated: now - 10, created: 2 }),
      item('legacy', { status: 'removed', updated: now - 10, created: 3 }),
      item('cleared', { status: 'done', hidden: true, updated: now - 10, created: 4 }),
      item('old', { status: 'removed', by: 'api-design', updated: now - 3_600_001, created: 5 }),
    ]
    expect(visible(list, now).map(one => one.id)).toEqual(['bysession'])
  })
  test('numbers count open items only, in the order asked; next is the first waiting and unblocked', () => {
    const list = [
      item('done', { status: 'done', created: 1 }),
      item('fail', { status: 'failed', created: 2 }),
      item('blocked', { after: 'fail', created: 3 }),
      item('free', { created: 4 }),
    ]
    expect(list.map(one => numberOf(one, list))).toEqual([undefined, 1, 2, 3])
    expect(nextItem(list)?.id).toBe('free')
    expect(nextItem([item('a', { status: 'failed' })])).toBeUndefined()
  })
  test('the summary counts waiting and failed and names the next', () => {
    expect(summary([])).toBe('Nothing waits for you.')
    expect(summary([item('a', { why: 'backend apply', created: 1 }), item('b', { created: 2 })])).toBe('2 waiting · next: backend apply')
    expect(summary([item('a', { status: 'failed' })])).toBe('1 failed')
  })
  test('the kind is inferred from the guard\'s reason, then the program', () => {
    expect(kindOf('', undefined)).toBe('decision')
    expect(kindOf('   ', 'anything')).toBe('decision')
    expect(kindOf('make apply STACK=x', heldReason('make apply STACK=x'))).toBe('aws-change')
    expect(kindOf('aws s3 rm s3://b/k', heldReason('aws s3 rm s3://b/k'))).toBe('aws-change')
    expect(kindOf('git push origin main', heldReason('git push origin main'))).toBe('github')
    expect(kindOf('gh api -X PUT repos/a/b/x', heldReason('gh api -X PUT repos/a/b/x'))).toBe('github')
    expect(kindOf('gh pr ready 3', undefined)).toBe('github')
    expect(kindOf('rc start ecc main', undefined)).toBe('desktop')
    expect(kindOf('make check', undefined)).toBe('local')
    expect(isKind('desktop')).toBe(true)
    expect(isKind('Desktop')).toBe(false)
  })
  test('a command folds to its first line, and ages are short', () => {
    expect(fold('a\nb\nc')).toEqual({ head: 'a', more: 2 })
    expect(fold('one line')).toEqual({ head: 'one line', more: 0 })
    expect([0, 59_999, 60_000, 3_599_999, 3_600_000, 86_400_000, -5].map(age)).toEqual(['now', 'now', '1 min', '59 min', '1 h', '1 d', 'now'])
  })
  test('the list names who removed an item and why', () => {
    const list = [item('a', { status: 'removed', by: 'api-design › P2', note: 'dup', updated: now - 10 })]
    expect(listing(list, now, false)).toContain('removed by api-design › P2: dup')
    expect(listing([], now, false)).toContain('Nothing waits')
    expect(listing([], now, true)).toBe('The queue is empty.')
  })
})
