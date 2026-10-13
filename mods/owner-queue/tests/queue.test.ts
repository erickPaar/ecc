import { describe, expect, test } from 'claude-code/testing'

import type { Item } from '../types'
import { blocker, canMark, heldReason, markers, visible, withMarker } from '../hooks/queue'

const HELD = [
  'tofu apply -auto-approve',
  'cd infra && AWS_PROFILE=sandbox make apply STACK=records ENV=sandbox',
  'terraform -chdir=stacks/agent destroy',
  'tofu state rm module.x',
  'aws s3 rm s3://bucket/key',
  'aws --profile sandbox iam delete-role --role-name x',
  'aws ssm put-parameter --name /x --value y',
  'aws s3 cp ./file s3://bucket/key',
  'aws s3 sync ./dir s3://bucket/prefix --delete',
  'gh pr merge 113 --squash',
  'gh variable set AGENT_ECR_REPOSITORY --body x',
  'gh secret delete TOKEN',
  'gh repo edit --default-branch main',
  'gh api -X PUT repos/o/r/branches/main/protection',
  'gh api --method=DELETE repos/o/r/hooks/1',
  'gh api -X POST repos/o/r/rulesets -f name=x',
  'gh repo create o/new --private',
  'export AWS_PROFILE=prd; for s in a b; do aws secretsmanager delete-secret --secret-id "x/$s"; done',
  'cd infra && AWS_PROFILE=x tofu -chdir=stacks/a apply',
  '! tofu apply',
]

const ALLOWED = [
  'tofu plan',
  'make check',
  'make -C prototype up',
  'make apply-docs-preview-not-a-target',
  'aws sts get-caller-identity',
  'aws s3 ls s3://bucket/',
  'aws s3 cp s3://bucket/key ./file',
  'aws ssm get-parameter --name /x',
  'gh pr view 113',
  'gh pr comment 113 --body "verdict"',
  'gh api repos/o/r/pulls/113',
  'gh api -X POST repos/o/r/issues/113/comments -f body=x',
  'git push -u origin feat/x',
  'echo "tofu apply is held"',
  'git grep -n "make apply " -- README.md',
  "grep -rn 'tofu apply -auto-approve' docs/",
  "sed -i 's/make apply ENV=prd refuses/make apply ENV=prd still refuses/' README.md",
  'git commit -m "docs: run tofu apply after the merge"',
  'claude -p "review the PR; never run gh pr merge"',
  'aws bedrock-agentcore-control create-harness help 2>&1 | head -20',
  'aws bedrock-runtime invoke-model --model-id x --body "{}" out.json',
  'git add prototype/aws && git commit -m x && git remote set-url origin https://x',
  'ls ~/.aws; git push --set-upstream origin x',
  'aws s3 ls s3://b/ && git tag -d v1',
]

// Quoted text a shell runs is a command again.
const HELD_QUOTED = [
  "bash -c 'tofu apply'",
  'sh -lc "make apply STACK=agent"',
  'eval "gh pr merge 1 --squash"',
  "ssh host 'aws s3 rm s3://b/k'",
  'echo "$(make apply STACK=agent)"',
  'x="`tofu apply`"',
  'out=$(tofu apply -auto-approve)',
  '(cd infra && make apply STACK=x)',
]

describe('heldReason', () => {
  for (const command of HELD) {
    test(`holds: ${command}`, () => {
      expect(heldReason(command)).toBeDefined()
    })
  }
  for (const command of HELD_QUOTED) {
    test(`holds what a shell runs from quotes: ${command}`, () => {
      expect(heldReason(command)).toBeDefined()
    })
  }
  for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
      expect(heldReason(command)).toBeUndefined()
    })
  }
  test('a heredoc read by a program that runs no commands is data', () => {
    const script = "python3 - $D <<'EOF'\ns = 'make apply STACK=x'\nEOF\nmake check"
    expect(heldReason(script)).toBeUndefined()
    expect(heldReason("cat > notes.md <<EOF\nrun tofu apply later\nEOF")).toBeUndefined()
  })
  test('a heredoc a shell reads is still checked, and so is the rest of the command', () => {
    expect(heldReason("bash <<'EOF'\nmake apply STACK=x\nEOF")).toBeDefined()
    expect(heldReason("ssh host <<EOF\ntofu apply\nEOF")).toBeDefined()
    expect(heldReason("cat <<'EOF' | bash\ntofu apply\nEOF")).toBeDefined()
    expect(heldReason("cat > f <<'EOF'\nx\nEOF\ntofu apply")).toBeDefined()
  })
  test('the person\'s own expression holds more', () => {
    expect(heldReason('kubectl delete pod x', 'kubectl\\s+delete')).toBe('held by your settings')
  })
  test('an invalid expression of the person holds nothing more', () => {
    expect(heldReason('kubectl delete pod x', '(')).toBeUndefined()
  })
})

describe('markers', () => {
  test('a copied command prints its exit code, and the output names it', () => {
    const copied = withMarker({ id: 'abc123', command: 'make apply STACK=records' })
    expect(copied).toBe('make apply STACK=records; echo "oq:abc123:$?"')
    expect(markers('<bash-stdout>Apply complete!\noq:abc123:0</bash-stdout>')).toEqual([{ id: 'abc123', code: 0 }])
    expect(markers('oq:abc123:2')).toEqual([{ id: 'abc123', code: 2 }])
  })
  test('a command a marker would break gets none', () => {
    for (const command of ['make apply # records', 'sleep 1 &', 'a;', '', 'a\nb']) {
      expect(canMark(command)).toBe(false)
      expect(withMarker({ id: 'x', command })).toBe(command)
    }
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
})
