import { describe, expect, test } from 'claude-code/testing'

import { heldReason, pushDirs } from '../hooks/guard'
import { commands } from '../hooks/shell'

// One case per alternative of each rule, so narrowing a rule fails a test.
const HELD: [string, string][] = [
  // infrastructure
  ['tofu apply -auto-approve', 'infrastructure change'],
  ['terraform -chdir=infra/app destroy', 'infrastructure change'],
  ['terragrunt apply-all', 'infrastructure change'],
  ['terragrunt destroy-all', 'infrastructure change'],
  ['terragrunt run --all apply', 'infrastructure change'],
  ['tofu workspace delete dev', 'infrastructure change'],
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
  ['make -j apply', 'infrastructure change'],
  ['make -j 4 apply', 'infrastructure change'],
  ['make -l 2.5 destroy', 'infrastructure change'],
  // AWS
  ['aws s3 rm s3://bucket/key', 'destructive AWS call'],
  ['aws s3 rb s3://bucket --force', 'destructive AWS call'],
  ['aws s3 mv s3://b/a s3://b/c', 'destructive AWS call'],
  ['aws s3api delete-object --bucket b --key k', 'destructive AWS call'],
  ['aws --profile prod iam delete-role --role-name x', 'destructive AWS call'],
  ['aws secretsmanager delete-secret --secret-id x', 'destructive AWS call'],
  ['aws ec2 terminate-instances --instance-ids i-1', 'destructive AWS call'],
  ['aws ec2 terminate-instances --instance-ids i-1 --query help', 'destructive AWS call'],
  ['aws dynamodb delete-table --table-name help', 'destructive AWS call'],
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
  ['aws s3 cp f s3://b/k --request-payer requester', 'upload to S3'],
  ['aws s3 cp f s3://b/k --copy-props none', 'upload to S3'],
  ['aws s3 cp --unlisted-option v f s3://b/k', 'upload to S3'],
  ['aws s3 cp f s3://b/k --unlisted-option v', 'upload to S3'],
  // GitHub
  ['gh workflow run apply-prod.yml -f confirm=prod', 'GitHub Actions run'],
  ['gh workflow enable cd.yml', 'GitHub Actions run'],
  ['gh run rerun 123', 'GitHub Actions run'],
  ['gh variable set IMAGE_REPOSITORY --body x', 'GitHub repository settings'],
  ['gh secret --env prod set TOKEN', 'GitHub repository settings'],
  ['gh -R o/r secret -e prod delete TOKEN', 'GitHub repository settings'],
  ['gh variable --org o set X', 'GitHub repository settings'],
  ['gh workflow --ref main run deploy.yml', 'GitHub Actions run'],
  ['gh repo deploy-key add key.pub', 'GitHub repository settings'],
  ['gh repo deploy-key delete 1', 'GitHub repository settings'],
  ['gh secret delete TOKEN', 'GitHub repository settings'],
  ['gh variable remove X', 'GitHub repository settings'],
  ['gh repo edit --default-branch main', 'GitHub repository settings'],
  ['gh repo create o/new --private', 'GitHub repository settings'],
  ['gh repo delete o/old --yes', 'GitHub repository settings'],
  ['gh api -X PUT repos/o/r/branches/main/protection', 'GitHub API write'],
  ['gh api -X "PUT" repos/o/r/vulnerability-alerts', 'GitHub API write'],
  ["gh api --method 'DELETE' repos/o/r/hooks/1", 'GitHub API write'],
  ['gh api --method=PATCH repos/o/r', 'GitHub API write'],
  ['gh api -XDELETE repos/o/r/hooks/9', 'GitHub API write'],
  ['gh api -X DELETE repos/o/r/issues/9', 'GitHub API write'],
  ['gh api -X PUT repos/o/r/contents/pulls/1/merge -f message=x', 'GitHub API write'],
  ['gh api -X DELETE repos/o/r/contents/comments/1', 'GitHub API write'],
  ['gh api -X POST repos/o/r/rulesets -f name=x', 'GitHub API write'],
  ['gh api repos/o/r/hooks -f url=https://x', 'GitHub API write'],
  ['gh api repos/o/r/rulesets --input rules.json', 'GitHub API write'],
  ['gh api repos/o/r/rulesets --input=rules.json', 'GitHub API write'],
  ['gh api repos/o/r/hooks -fref=main', 'GitHub API write'],
  ['gh api repos/o/r/hooks -Factive=true', 'GitHub API write'],
  ['gh api repos/o/r/hooks --field=url=https://x', 'GitHub API write'],
  ['gh api repos/o/r/hooks --raw-field=url=https://x', 'GitHub API write'],
  ['gh api -XPATCH repos/o/r', 'GitHub API write'],
  ['gh api repos/o/r/actions/runs/1/pending_deployments -F environment_ids[]=1 -f state=approved', 'GitHub API write'],
  ['gh api repos/o/r/statuses/abc123 -f state=success', 'GitHub API write'],
  ['gh api repos/o/r/check-runs -f name=ci -f head_sha=abc', 'GitHub API write'],
  ['gh api repos/o/r/transfer -f new_owner=x', 'GitHub API write'],
  ['gh api repos/o/r/actions/workflows/apply-prod.yml/dispatches -f ref=main', 'GitHub API write'],
  ['gh api -X POST repos/o/r/actions/runs/1/rerun', 'GitHub API write'],
  ['gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"', 'GitHub API write'],
  ['gh api graphql -fquery=mutation{addStar(input:{}){clientMutationId}}', 'GitHub API write'],
  ['gh api graphql -F query=@q.graphql', 'GitHub API write'],
  ['gh api graphql --input q.json', 'GitHub API write'],
  ['git push origin HEAD:main', 'push to the default branch'],
  ['git push origin main', 'push to the default branch'],
  ['git push -f origin +feat/x:refs/heads/master', 'push to the default branch'],
  ['git push --mirror origin', 'push to the default branch'],
  ['git push --all origin', 'push to the default branch'],
  ['git push --branches origin', 'push to the default branch'],
  ['git -C repo push origin main', 'push to the default branch'],
  ['git push -o ci.skip origin main', 'push to the default branch'],
  ['git push', 'push from a branch the guard could not read'],
  ['claude plugin disable owner-queue@market', 'plugin settings'],
  ['claude plugin uninstall owner-queue@market', 'plugin settings'],
  ['claude plugin marketplace remove market', 'plugin settings'],
  ['claude plugins disable owner-queue@market', 'plugin settings'],
  ['eval eval eval eval eval echo hi', 'command nested too deeply to read'],
  [`x=${'$('.repeat(10)}echo hi${')'.repeat(10)}`, 'command nested too deeply to read'],
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
  'STACK=x make apply',
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
  // control flow and functions (the review's cases, then the same with make, which only the
  // first word of a command can hold)
  'if tofu apply -auto-approve; then echo ok; fi',
  'while ! aws s3 cp f s3://b/k; do sleep 5; done',
  'until terraform apply -auto-approve; do sleep 5; done',
  'if make apply; then echo ok; fi',
  'if true; then :; elif make apply; then :; fi',
  'while ! make apply; do sleep 5; done',
  'until make apply; do sleep 5; done',
  'coproc make apply',
  'coproc APPLY { make apply; }',
  'function deploy { make apply; }',
  'function deploy() { make apply; }',
  'deploy() { make apply; }',
  // wrapper options that take a value
  'timeout -k 10 600 tofu apply',
  'timeout -k 10 600 make apply',
  'timeout -s KILL 60 make apply',
  'timeout --signal=KILL 60 make apply',
  'timeout 600 make apply',
  'env -C infra make apply',
  'env -u AWS_PROFILE make apply',
  "env -S 'make apply'",
  'env -S"make apply STACK=x"',
  'sudo -g ops make apply',
  'doas -u ops make apply',
  'time -o log make apply',
  'caffeinate -w 123 make apply',
  'nohup make apply &',
  'command make apply',
  'sudo -u ops -g ops -D /srv tofu apply',
  'sudo -C 3 make apply STACK=x',
  'exec -a deploy make apply STACK=x',
  'echo x | xargs --max-args 1 make apply',
  'xargs -n 1 make apply < list',
  'xargs -P 4 -I {} make apply STACK={}',
  'xargs -L 1 make apply',
  "xargs -d '\\n' -s 100 make apply",
  'echo apply | xargs tofu',
  'nice -n 10 make apply',
  'nice -10 make apply',
  'ionice -c 2 -n 7 make apply',
  'chrt -f 10 make apply',
  'taskset -c 0-3 make apply',
  'stdbuf -o L make apply',
  'stdbuf -oL make apply',
  // other programs that run a command
  'find . -name main.tf -execdir make apply \\;',
  "find . -exec make apply ';'",
  'find . -exec make apply {} + -print',
  'find . -exec echo {} + -exec make apply {} +',
  'aws-vault exec prod -- make apply STACK=x',
  'aws-vault exec prod make apply STACK=x',
  'aws-vault exec --duration 1h prod -- aws s3 rm s3://b/k',
  'flock /tmp/lock make apply',
  "flock -w 5 /tmp/lock -c 'make apply'",
  'direnv exec infra make apply',
  'su -c "make apply" ops',
  "su - ops -c 'make apply'",
  "echo 'make apply' | su ops",
  'docker compose run --rm -e X=1 app make apply',
  'docker compose -f c.yml exec app make apply STACK=x',
  'docker-compose run app make apply',
  'docker run --rm -v "$PWD:/w" -w /w hashicorp/terraform apply',
  'docker exec -it box make apply',
  'podman run img make apply STACK=x',
  'kubectl exec pod -- make apply',
  'kubectl exec -i pod -- sh <<EOF\nmake apply\nEOF',
  'mywrapper --verbose tofu apply',
  'mywrapper /usr/local/bin/tofu apply',
  'bash -c "make \\\napply"',
  'x=$(echo "$(echo ")")"; make apply)',
  // what a shell reads on its standard input
  "echo 'make apply' | bash",
  "printf 'make apply\\n' | sh -s",
  'echo make apply | tee log | bash',
  "bash <<< 'make apply'",
  'sh <<< "make apply STACK=x"',
  "echo 'make apply' | ssh host",
  // quoting
  'echo a \\\\\nmake apply',
  'x=$(echo ")"; make apply)',
  "x=$(echo ')'; make apply)",
]

const ALLOWED = [
  'tofu plan',
  'tofu init -backend=false',
  'tofu state list',
  'make check',
  'make -C web up',
  'make -n apply',
  'make --dry-run apply STACK=x',
  'make --just-print destroy',
  'make -j 4 check',
  'tofu apply -help',
  'terraform destroy --help',
  'terragrunt run --all plan',
  'tofu workspace list',
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
  'aws ec2 run-instances help 2>&1 | head -20',
  'aws help',
  'aws ec2 help',
  'aws s3 help',
  'aws s3 cp s3://b/k ./f --request-payer requester',
  'aws eks update-kubeconfig --name c --region us-east-1',
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
  'gh api graphql -fquery={viewer{login}}',
  'gh api -X DELETE repos/o/r/issues/comments/9',
  'gh api -X DELETE repos/o/r/pulls/comments/9',
  'gh api -X DELETE repos/o/r/comments/9',
  'gh repo deploy-key list',
  'gh secret --env prod list',
  'git push -u origin feat/x',
  'git push origin feat/main-menu',
  'echo "tofu apply is held"',
  'git grep -n "make apply " -- README.md',
  "grep -rn 'tofu apply -auto-approve' docs/",
  "sed -i 's/make apply ENV=prod refuses/make apply ENV=prod still refuses/' README.md",
  'git commit -m "docs: run tofu apply after the merge"',
  'claude -p "review the PR; never run gh pr merge"',
  'git add src/tofu apply',
  "echo 'make apply' || bash -l",
  "aws s3 cp --recursive --exclude '*.tmp' s3://b/prefix ./out",
  'aws s3 cp --request-payer requester s3://b/k ./f',
  'git add src/aws && git commit -m x && git remote set-url origin https://x',
  'cat setup.sh | bash',
  'command -v uv aws docker make',
  'which aws tofu terraform gh',
  'for t in aws tofu gh; do printf "%s" "$t"; done',
  'git ls-files src/aws docs',
  'ls -d infra/aws/bin/tofu',
  'gh secret --env prod set --help',
  'gh workflow run -h',
  'docker run constructor toString',
  'toString valueOf',
  'echo hi | xargs echo',
  "cat > notes.md <<-EOF\n\ttofu apply\n\tEOF",
  'echo done \\\\',
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

describe('a push with no refspec', () => {
  const on = (branch: string) => new Map([['', branch]])
  test('is held when the current branch is the default one', () => {
    for (const command of ['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin @', 'git push --force', 'git push -o ci.skip origin']) {
      expect(heldReason(command, '', on('main'))).toBe('push to the default branch')
      expect(heldReason(command, '', on('master'))).toBe('push to the default branch')
      expect(heldReason(command, '', on('feat/x'))).toBeUndefined()
    }
  })
  test('is held when the branch could not be read', () => {
    expect(heldReason('git push origin HEAD')).toBe('push from a branch the guard could not read')
  })
  test('names the folders whose branch it needs', () => {
    expect(pushDirs('git push')).toEqual([''])
    expect(pushDirs('git -C other push')).toEqual(['other'])
    expect(pushDirs('cd /srv/repo && git push')).toEqual(['', '/srv/repo'])
    expect(pushDirs('git push origin feat/x')).toEqual([])
    expect(pushDirs('git push origin HEAD:feat/x')).toEqual([])
    expect(pushDirs('git -C . push')).toEqual([''])
    expect(pushDirs('cd /srv/repo && git -C /other push')).toEqual(['/other'])
    expect(pushDirs('cd /srv && cd repo && git push')).toEqual(['', '/srv', '/srv/repo'])
  })
  test('reads the branch in the folder it runs in', () => {
    const branches = new Map([['', 'feat/x'], ['other', 'main'], ['/srv/repo', 'main']])
    expect(heldReason('git -C other push', '', branches)).toBe('push to the default branch')
    expect(heldReason('cd /srv/repo && git push', '', branches)).toBe('push to the default branch')
    expect(heldReason('git push', '', branches)).toBeUndefined()
  })
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
  test('a backslash before a newline joins the lines; an escaped backslash does not', () => {
    expect(commands('a \\\nb')).toEqual([['a', 'b']])
    expect(commands('a\\\nb')).toEqual([['ab']])
    expect(commands('a \\\\\nb')).toEqual([['a', '\\'], ['b']])
  })
  test('a redirection target is one word, quotes and all', () => {
    expect(commands("a > 'my file' b")).toEqual([['a', 'b']])
  })
  test('an unbalanced quote keeps the rest in the word', () => {
    expect(commands("echo 'tofu apply")).toEqual([['echo', 'tofu apply']])
  })
})
