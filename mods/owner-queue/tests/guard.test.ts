import { describe, expect, test } from 'claude-code/testing'

import { heldReason } from '../hooks/guard'
import { commands } from '../hooks/shell'

// One case per alternative of each rule, so narrowing a rule fails a test.
const HELD: [string, string][] = [
  // infrastructure
  ['tofu apply -auto-approve', 'infrastructure change'],
  ['terraform -chdir=stacks/agent destroy', 'infrastructure change'],
  ['terragrunt run-all destroy', 'infrastructure change'],
  ['tofu import aws_s3_bucket.x b', 'infrastructure change'],
  ['tofu taint x', 'infrastructure change'],
  ['tofu force-unlock 123', 'infrastructure change'],
  ['tofu state rm module.x', 'infrastructure change'],
  ['tofu state mv a b', 'infrastructure change'],
  ['tofu state push s.tfstate', 'infrastructure change'],
  ['make apply STACK=network ENV=dev', 'infrastructure change'],
  ['make -C infra apply', 'infrastructure change'],
  ['make destroy STACK=x', 'infrastructure change'],
  ['make import STACK=x ADDR=y ID=z', 'infrastructure change'],
  // AWS
  ['aws s3 rm s3://bucket/key', 'destructive AWS call'],
  ['aws s3 rb s3://bucket --force', 'destructive AWS call'],
  ['aws s3 mv s3://b/a s3://b/c', 'destructive AWS call'],
  ['aws s3api delete-object --bucket b --key k', 'destructive AWS call'],
  ['aws --profile prod iam delete-role --role-name x', 'destructive AWS call'],
  ['aws secretsmanager delete-secret --secret-id x', 'destructive AWS call'],
  ['aws ec2 terminate-instances --instance-ids i-1', 'destructive AWS call'],
  ['aws kms schedule-key-deletion --key-id k', 'destructive AWS call'],
  ['aws ecr batch-delete-image --repository-name r --image-ids imageTag=x', 'destructive AWS call'],
  ['aws ssm put-parameter --name /x --value y', 'AWS write'],
  ['aws cloudformation deploy --template-file t.yml --stack-name s', 'AWS write'],
  ['aws cloudformation execute-change-set --change-set-name c', 'AWS write'],
  ['aws lambda invoke --function-name f out.json', 'AWS write'],
  ['aws cognito-idp admin-create-user --user-pool-id p --username u', 'AWS write'],
  ['aws route53 change-resource-record-sets --hosted-zone-id z --change-batch file://c.json', 'AWS write'],
  ['aws ec2 run-instances --image-id ami-1', 'AWS write'],
  ['aws ssm send-command --instance-ids i-1 --document-name AWS-RunShellScript', 'AWS write'],
  ['aws dynamodb batch-write-item --request-items file://x.json', 'AWS write'],
  ['aws s3 mb s3://new-bucket', 'AWS write'],
  ['aws s3 cp ./file s3://bucket/key', 'upload to S3'],
  ['aws s3 sync ./dir s3://bucket/prefix --delete', 'upload to S3'],
  ['aws s3 cp out.json "s3://$BUCKET/data/$ID/x.json"', 'upload to S3'],
  ['aws s3 cp f s3://b/k 2>&1 | tail -3', 'upload to S3'],
  ['aws s3 cp f s3://b/k > log', 'upload to S3'],
  ['aws s3 cp --recursive . s3://b/ --exclude "*.pdf"', 'upload to S3'],
  // GitHub
  ['gh workflow run apply-prod.yml -f confirm=prod', 'GitHub Actions run'],
  ['gh workflow enable cd.yml', 'GitHub Actions run'],
  ['gh run rerun 123', 'GitHub Actions run'],
  ['gh variable set AGENT_ECR_REPOSITORY --body x', 'GitHub repository settings'],
  ['gh secret delete TOKEN', 'GitHub repository settings'],
  ['gh variable remove X', 'GitHub repository settings'],
  ['gh repo edit --default-branch main', 'GitHub repository settings'],
  ['gh repo create o/new --private', 'GitHub repository settings'],
  ['gh repo delete o/old --yes', 'GitHub repository settings'],
  ['gh api -X PUT repos/o/r/branches/main/protection', 'GitHub API write'],
  ['gh api -X "PUT" repos/o/r/vulnerability-alerts', 'GitHub API write'],
  ["gh api --method 'DELETE' repos/o/r/hooks/1", 'GitHub API write'],
  ['gh api --method=PATCH repos/o/r', 'GitHub API write'],
  ['gh api -XDELETE repos/o/r/issues/comments/9', 'GitHub API write'],
  ['gh api -X POST repos/o/r/rulesets -f name=x', 'GitHub API write'],
  ['gh api repos/o/r/hooks -f url=https://x', 'GitHub API write'],
  ['gh api repos/o/r/rulesets --input rules.json', 'GitHub API write'],
  ['gh api repos/o/r/actions/workflows/apply-prod.yml/dispatches -f ref=main', 'GitHub API write'],
  ['gh api -X POST repos/o/r/actions/runs/1/rerun', 'GitHub API write'],
  ['gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"', 'GitHub API write'],
  ['git push origin HEAD:main', 'push to the default branch'],
  ['git push origin main', 'push to the default branch'],
  ['git push -f origin +feat/x:refs/heads/master', 'push to the default branch'],
  ['git push --mirror origin', 'push to the default branch'],
  ['claude plugin disable owner-queue@erick', 'plugin settings'],
  ['claude plugin uninstall owner-queue@erick', 'plugin settings'],
  ['claude plugin marketplace remove erick', 'plugin settings'],
]

// Spellings that run the same thing.
const HELD_SPELLINGS = [
  'tofu -chdir=stacks/a \\\napply',
  'aws s3 cp ./f \\\n  s3://b/k',
  'aws --profile prod \\\n  iam delete-role --role-name x',
  'make -C infra \\\n  apply',
  'gh api repos/o/r/branches/main/protection \\\n  --method PUT',
  '/usr/local/bin/tofu apply',
  '~/.local/bin/aws s3 rm s3://b/k',
  'AWS_PROFILE=prod aws s3 rm s3://b/k',
  'env AWS_PROFILE=prod tofu apply',
  'sudo -u ops tofu apply',
  'timeout 600 tofu apply',
  'nohup tofu apply &',
  'command tofu apply',
  'time make apply STACK=x',
  "bash -c 'tofu apply'",
  'sh -lc "make apply STACK=app"',
  "bash -o pipefail -c 'make apply STACK=x | tee log'",
  'eval "tofu apply"',
  "ssh host 'aws s3 rm s3://b/k'",
  "watch -n 5 'gh run rerun 1'",
  'echo x | xargs tofu apply',
  "script -q -c 'tofu apply' /dev/null",
  'echo "$(make apply STACK=app)"',
  'x="`tofu apply`"',
  'out=$(tofu apply -auto-approve)',
  '(cd infra && make apply STACK=x)',
  '{ tofu apply; }',
  'if true; then tofu apply; fi',
  "bash <<'EOF'\nmake apply STACK=x\nEOF",
  'ssh host <<EOF\ntofu apply\nEOF',
  'echo `tofu apply`',
  'gh -R o/r workflow run deploy.yml',
  "cat <<'EOF' | bash\ntofu apply\nEOF",
  'cat > f <<EOF\n$(tofu apply)\nEOF',
  "cat > f <<'EOF'\nx\nEOF\ntofu apply",
  "t'of'u apply",
  "$'tofu' apply",
]

const ALLOWED = [
  'tofu plan',
  'tofu init -backend=false',
  'tofu state list',
  'make check',
  'make -C prototype up',
  'make apply-docs-preview-not-a-target',
  'make plan STACK=apply',
  'aws sts get-caller-identity',
  'aws sso login --profile dev',
  'aws s3 ls s3://bucket/',
  'aws s3 cp s3://bucket/key ./file',
  'aws s3 cp s3://b/reports/x/summary.md - --profile dev | tail -3',
  'aws s3 presign s3://b/k',
  'aws ssm get-parameter --name /x',
  'aws s3api list-objects-v2 --bucket b',
  'aws logs tail /aws/x --follow',
  'aws logs start-query --log-group-name g --query-string q',
  'aws athena start-query-execution --query-string "select 1"',
  'aws dynamodb query --table-name t',
  'aws ecr get-login-password | docker login',
  'aws bedrock-runtime invoke-model --model-id x --body "{}" out.json',
  'aws bedrock-agentcore-control create-harness help 2>&1 | head -20',
  'aws configure list',
  'aws cognito-idp admin-get-user --user-pool-id p --username u',
  'aws events test-event-pattern --event-pattern "$P" --event "$E"',
  'aws iam generate-service-last-accessed-details --arn arn:aws:iam::1:role/r',
  'gh pr view 113',
  'gh pr merge 113 --squash',
  'gh pr comment 113 --body "verdict"',
  'gh pr edit 113 --body-file b.md',
  'gh ruleset list',
  'gh ruleset view 1',
  'gh workflow list',
  'gh run view 1 --log',
  'gh api repos/o/r/pulls/113',
  'gh api repos/o/r/pulls/113/comments',
  'gh api -X POST repos/o/r/issues/113/comments -f body=x',
  'gh api -X PATCH repos/o/r/pulls/113 -f body=x',
  'gh api -X PUT repos/o/r/pulls/113/merge',
  'gh api graphql -f query="{ viewer { login } }"',
  'git push -u origin feat/x',
  'git push origin feat/main-menu',
  'git push',
  'echo "tofu apply is held"',
  'git grep -n "make apply " -- README.md',
  "grep -rn 'tofu apply -auto-approve' docs/",
  "sed -i 's/make apply ENV=prod refuses/make apply ENV=prod still refuses/' README.md",
  'git commit -m "docs: run tofu apply after the merge"',
  'claude -p "review the PR; never run gh pr merge"',
  'git add prototype/aws && git commit -m x && git remote set-url origin https://x',
  'ls ~/.aws; git push --set-upstream origin x',
  'aws s3 ls s3://b/ && git tag -d v1',
  "python3 - $D <<'EOF'\ns = 'make apply STACK=x'\nEOF\nmake check",
  'cat > notes.md <<EOF\nrun tofu apply later\nEOF',
  'cat > notes.md <<EOF\ntofu apply\nEOF',
  'ls # ; tofu apply',
  'make -C apply lint',
  'claude plugin list',
  '# tofu apply',
]

describe('held', () => {
  for (const [command, what] of HELD) {
    test(`${what}: ${command}`, () => {
      expect(heldReason(command)).toBe(what)
    })
  }
  for (const command of HELD_SPELLINGS) {
    test(`held whatever the spelling: ${JSON.stringify(command)}`, () => {
      expect(heldReason(command)).toBeDefined()
    })
  }
})

describe('allowed', () => {
  for (const command of ALLOWED) {
    test(`allowed: ${JSON.stringify(command)}`, () => {
      expect(heldReason(command)).toBeUndefined()
    })
  }
})

describe('the person\'s own expression', () => {
  test('holds more, per simple command', () => {
    expect(heldReason('kubectl delete pod x', 'kubectl\\s+delete')).toBe('held by your settings')
    expect(heldReason('gh pr merge 5 --squash', 'gh\\s+pr\\s+merge')).toBe('held by your settings')
    expect(heldReason('gh pr merge 5 --squash')).toBeUndefined()
  })
  test('an invalid one holds nothing more', () => {
    expect(heldReason('kubectl delete pod x', '(')).toBeUndefined()
  })
})

describe('the shell reader', () => {
  test('splits commands and takes quotes off', () => {
    expect(commands(`a 'b c' "d e" f\\ g; h && i | j`)).toEqual([['a', 'b c', 'd e', 'f g'], ['h'], ['i'], ['j']])
  })
  test('drops redirections and their targets', () => {
    expect(commands('a > out 2>&1 < in')).toEqual([['a']])
  })
  test('an unbalanced quote keeps the rest in the word', () => {
    expect(commands("echo 'tofu apply")).toEqual([['echo', 'tofu apply']])
  })
})
