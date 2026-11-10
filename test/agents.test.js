import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCodex, parseRules, readToml, ruleDecision } from '../src/codex.js';
import { evaluateCursor, shellRules } from '../src/cursor.js';

test('Codex config keys and project sections are read', () => {
  const toml = readToml(`# comment
approval_policy = "never"   # trailing
sandbox_mode = 'workspace-write'

[sandbox_workspace_write]
network_access = true

[projects.'c:\\work\\app']
trust_level = "trusted"
`);
  assert.equal(toml.top.approval_policy, 'never');
  assert.equal(toml.top.sandbox_mode, 'workspace-write');
  assert.equal(toml.sections.sandbox_workspace_write.network_access, 'true');
  assert.equal(toml.sections["projects.'c:\\work\\app'"].trust_level, 'trusted');
});

test('Codex prefix rules are read, including multi-line rules and alternatives', () => {
  const { rules, unread } = parseRules(`prefix_rule(pattern=["terraform", "destroy"], decision="forbidden")
prefix_rule(
    pattern = ["gh", "pr", ["view", "list"]],
    decision = "prompt",
    justification = "Viewing PRs needs approval",
    match = ["gh pr view 7888"],
)
prefix_rule(pattern=["git", "status"])
prefix_rule(pattern=[broken], decision="allow")
`);
  assert.equal(unread, 1);
  assert.deepEqual(rules, [
    { pattern: ['terraform', 'destroy'], decision: 'forbidden' },
    { pattern: ['gh', 'pr', ['view', 'list']], decision: 'prompt' },
    { pattern: ['git', 'status'], decision: 'allow' },
  ]);
});

test('Codex rules match argument prefixes and the strictest one wins', () => {
  const { rules } = parseRules(`prefix_rule(pattern=["terraform", "destroy"], decision="forbidden")
prefix_rule(pattern=["gh", "pr", ["view", "list"]], decision="prompt")
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=["ls"], decision="allow")
prefix_rule(pattern=["C:\\\\Windows\\\\powershell.exe", "-Command", "Remove-Item build -Recurse"], decision="allow")
`);
  const decide = (command) => ruleDecision(command, rules);
  assert.equal(decide('terraform destroy -auto-approve'), 'forbidden');
  assert.equal(decide('cd infra && terraform destroy'), 'forbidden');
  assert.equal(decide('bash -lc "git status && terraform destroy"'), 'forbidden');
  assert.equal(decide('gh pr list'), 'prompt');
  assert.equal(decide('gh pr --repo openai/codex view 7888'), null, 'the pattern must be an exact prefix');
  assert.equal(decide('git status'), 'allow');
  assert.equal(decide('git status && ls -la'), 'allow');
  assert.equal(decide('git status && npm test'), null, 'allowing one part does not allow the whole line');
  assert.equal(decide('git status > out.txt'), null, 'a script with a redirect is not split');
  assert.equal(decide('Remove-Item build -Recurse'), 'allow', 'a rule saved for one exact script');
  assert.equal(decide('Remove-Item src -Recurse'), null);
});

test('Codex verdicts follow the sandbox and the approval policy', () => {
  const verdict = (input) => evaluateCodex({ command: 'x', ...input }).verdict;
  assert.equal(verdict({ effect: 'outside', sandbox: 'read-only' }), 'asks');
  assert.equal(verdict({ effect: 'workspace', sandbox: 'read-only' }), 'asks');
  assert.equal(verdict({ effect: 'workspace', sandbox: 'workspace-write' }), 'runs');
  assert.equal(verdict({ effect: 'git', sandbox: 'workspace-write' }), 'asks');
  assert.equal(verdict({ effect: 'outside', sandbox: 'workspace-write' }), 'asks');
  assert.equal(verdict({ effect: 'network', sandbox: 'workspace-write' }), 'asks');
  assert.equal(verdict({ effect: 'network', sandbox: 'workspace-write', network: true }), 'runs');
  assert.equal(verdict({ effect: 'outside', sandbox: 'workspace-write', approval: 'never' }), 'blocked');
  assert.equal(verdict({ effect: 'outside', sandbox: 'danger-full-access' }), 'runs');
  assert.equal(verdict({ effect: 'workspace', sandbox: 'workspace-write', approval: 'untrusted' }), 'asks');
  assert.equal(verdict({ effect: 'outside', sandbox: 'read-only', yolo: true }), 'runs');

  const rules = [{ pattern: ['x'], decision: 'forbidden' }];
  assert.equal(verdict({ effect: 'outside', sandbox: 'danger-full-access', rules }), 'blocked');
  assert.equal(verdict({ effect: 'outside', rules, yolo: true }), 'unknown', 'the docs do not say whether rules apply with --yolo');
  assert.equal(verdict({ effect: 'outside', rules: [{ pattern: ['x'], decision: 'allow' }] }), 'runs');
  assert.equal(verdict({ effect: 'outside', approval: 'never', rules: [{ pattern: ['x'], decision: 'prompt' }] }), 'blocked');
});

test('Cursor Shell rules are read from permission tokens', () => {
  assert.deepEqual(shellRules(['Shell(git)', 'Read(src/**)', 'Shell(curl:*)', 'nonsense']), [{ base: 'git' }, { base: 'curl', args: '*' }]);
  assert.deepEqual(shellRules(undefined), []);
});

test('Cursor verdicts follow deny, hooks, --force and the allow list', () => {
  const rules = { deny: shellRules(['Shell(rm)', 'Shell(curl:*example.com*)']), allow: shellRules(['Shell(git)', 'Shell(ls)']) };
  const verdict = (command, extra = {}) => evaluateCursor({ command, ...rules, ...extra }).verdict;
  assert.equal(verdict('rm -rf build'), 'blocked');
  assert.equal(verdict('cd a && rm -rf b', { yolo: true }), 'blocked', 'deny holds with --force');
  assert.equal(verdict("bash -c 'rm -rf build'"), 'asks', 'a wrapped rm is not the rm command');
  assert.equal(verdict("bash -c 'rm -rf build'", { yolo: true }), 'runs');
  assert.equal(verdict('curl https://example.com/x'), 'blocked');
  assert.equal(verdict('curl https://other.org'), 'asks');
  assert.equal(verdict('git reset --hard'), 'runs', 'Shell(git) allows every git subcommand');
  assert.equal(verdict('git status && ls'), 'runs');
  assert.equal(verdict('git status && npm test'), 'asks');
  assert.equal(verdict('npm test', { yolo: true }), 'runs');
  assert.equal(verdict('npm test', { yolo: true, hook: { decision: 'deny' } }), 'blocked');
  assert.equal(verdict('npm test', { yolo: true, hook: { decision: 'ask' } }), 'asks');
});
