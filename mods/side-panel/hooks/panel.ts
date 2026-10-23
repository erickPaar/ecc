// The pane's plain logic: reading `gh pr list` output, whether a head was reviewed, the review
// prompt, and the sections command's lines. No engine calls here, so tests reach it whole.

import type { Asked, Line, Merged, Pull } from '../types'

export type { Asked, Line, Merged, Pull }

type GhNote = { body?: string; author?: { login?: string } }

type GhPull = {
  number: number
  headRefOid: string
  isDraft: boolean
  title: string
  comments?: GhNote[]
  reviews?: GhNote[]
}

// The JSON fields the pane asks gh for.
export const GH_FIELDS = 'number,headRefOid,isDraft,title,comments,reviews'

// How long a pressed Review stays asked; after that the head shows Review again.
export const ASKED_FOR = 10 * 60_000

// One repository's open pull requests, from `gh pr list --json` + GH_FIELDS. A comment or a review
// counts only when one of `reviewers` wrote it: on a public repository anyone can comment.
export function pulls(repo: string, json: string, word: string, reviewers: readonly string[]): Pull[] {
  const list = JSON.parse(json) as GhPull[]
  return list.map(pr => ({
    repo,
    number: pr.number,
    sha: pr.headRefOid,
    title: pr.title,
    isDraft: pr.isDraft,
    isReviewed: [...(pr.comments ?? []), ...(pr.reviews ?? [])].some(
      c => reviewers.includes(c.author?.login ?? '') && names(c.body ?? '', pr.headRefOid, word),
    ),
  }))
}

// A comment reviews a head when it names its short SHA (7 characters or more of it) and, when a
// review pattern is set (a regular expression, case-insensitive), matches it too; a pattern that
// does not compile is matched as plain text.
export function names(body: string, sha: string, word: string): boolean {
  const mentions = (body.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? []).some(s => sha.toLowerCase().startsWith(s))
  if (!mentions) return false
  if (word === '') return true
  try {
    return new RegExp(word, 'i').test(body)
  } catch {
    return body.toLowerCase().includes(word.toLowerCase())
  }
}

export function key(pull: Pick<Pull, 'repo' | 'number' | 'sha'>): string {
  return `${pull.repo}#${pull.number}@${pull.sha}`
}

export function prompt(template: string, pull: Pull): string {
  // Functions, so a `$&` or `$\`` in a title is written as it is.
  return template
    .replaceAll('{repo}', () => pull.repo)
    .replaceAll('{number}', () => String(pull.number))
    .replaceAll('{sha}', () => pull.sha.slice(0, 7))
    .replaceAll('{title}', () => pull.title)
}

// What the pane shows next to a pull request: reviewed, asked from the pane in the last ten
// minutes, or waiting.
export function state(pull: Pull, asked: readonly Asked[], now: number): 'reviewed' | 'asked' | 'new' {
  if (pull.isReviewed) return 'reviewed'
  return asked.some(a => a.key === key(pull) && now - a.at < ASKED_FOR) ? 'asked' : 'new'
}

// The sections command's output: "## Title" headings, then lines; a leading ●, ✓ or ⠋ sets the tone.
export function lines(output: string): Line[] {
  return output
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line !== '')
    .map(line => {
      if (line.startsWith('## ')) return { kind: 'heading' as const, text: line.slice(3) }
      const tone = line.startsWith('●') ? 'red' : line.startsWith('✓') ? 'green' : line.startsWith('⠋') ? 'blue' : undefined
      return { kind: 'text' as const, text: line, ...(tone ? { tone } : {}) } as Line
    })
}

export function repos(setting: string): string[] {
  return setting.split(/\s+/).filter(repo => /^[\w.-]+\/[\w.-]+$/.test(repo))
}

// Logins, separated by spaces.
export function logins(setting: string): string[] {
  return setting.split(/\s+/).filter(login => login !== '')
}

export function seconds(setting: string): number {
  const n = Number.parseInt(setting, 10)
  return Number.isFinite(n) && n >= 15 ? n : 60
}

// The tabs, in the order their keys (1-4) name them. The queue is owner-queue's pane.
export const TABS = [
  { name: 'status', key: '1', pane: 'side-panel' },
  { name: 'queue', key: '2', pane: 'owner-queue' },
  { name: 'aws', key: '3', pane: 'side-panel-aws' },
  { name: 'today', key: '4', pane: 'side-panel-today' },
] as const

// How long the merged-today list is kept before gh is asked again.
export const TODAY_FOR = 2 * 60_000
// When the AWS login turns red.
export const AWS_WARN = 30 * 60_000

// The SSO start URL of an AWS profile, from ~/.aws/config: its own sso_start_url, or that of the
// [sso-session NAME] its sso_session names.
export function ssoStartUrl(config: string, profile: string): string | undefined {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const raw of config.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      current = new Map()
      sections.set((head[1] ?? '').trim().replace(/\s+/g, ' '), current)
    } else if (current && line.includes('=')) {
      const at = line.indexOf('=')
      current.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
  }
  const own = sections.get(profile === 'default' ? 'default' : `profile ${profile}`)
  if (own === undefined) return undefined
  const session = own.get('sso_session')
  return (session !== undefined ? sections.get(`sso-session ${session}`)?.get('sso_start_url') : undefined) ?? own.get('sso_start_url')
}

// The latest expiry (ms) among the cached SSO tokens for that start URL; files that are not
// tokens are skipped.
export function ssoExpiry(caches: readonly string[], startUrl: string): number | undefined {
  let latest: number | undefined
  for (const text of caches) {
    try {
      const token = JSON.parse(text) as { startUrl?: string; expiresAt?: string; accessToken?: string }
      if (token.startUrl !== startUrl || token.accessToken === undefined) continue
      const at = Date.parse(token.expiresAt ?? '')
      if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at
    } catch {
      // not a token
    }
  }
  return latest
}

// Time left as the pane shows it: 2h 05m, 12m, expired.
export function left(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

type GhMerged = { number: number; title: string; url: string; mergedAt?: string; mergeCommit?: { oid?: string } | null }

// The JSON fields of the merged-today read.
export const MERGED_FIELDS = 'number,title,url,mergedAt,mergeCommit'

// One repository's pull requests merged since `since` (ms, the start of today), newest first.
export function merged(repo: string, json: string, since: number): Merged[] {
  return (JSON.parse(json) as GhMerged[])
    .filter(pr => Date.parse(pr.mergedAt ?? '') >= since)
    .map(pr => ({ repo, number: pr.number, title: pr.title, url: pr.url, sha: (pr.mergeCommit?.oid ?? '').slice(0, 7), at: Date.parse(pr.mergedAt ?? '') }))
    .sort((a, b) => b.at - a.at)
}

// The start of the local day `now` falls in, and that day as gh's search reads it (YYYY-MM-DD).
export function today(now: number): { since: number; day: string } {
  const d = new Date(now)
  const since = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { since, day }
}
