// The pane's plain logic: reading `gh pr list` output, whether a head was reviewed, the review
// prompt, and the sections command's lines. No engine calls here, so tests reach it whole.

import type { Asked, Line, Pull } from '../types'

export type { Asked, Line, Pull }

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
