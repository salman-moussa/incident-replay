import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, patternMatches } from '../src/engine.js';
import { allSubcommands, splitCommand, stripWrappers } from '../src/shell.js';

const verdict = (input) => evaluate(input).verdict;

test('wildcards match the table in the Claude Code docs', () => {
  const rows = [
    ['npm run build', 'npm run build', true], ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run', true], ['npm run *', 'npm run test --watch', true], ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true], ['git log * main', 'git log main', false],
    ['git * main', 'git -c core.fsmonitor=x diff main', true], ['git * main', 'git log', false],
    ['* --version', 'node --version', true], ['* --version', 'node -v', false],
    ['ls *', 'ls', true], ['ls *', 'ls -la', true], ['ls *', 'lsof', false], ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true], ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true], ['git:* push', 'git push', false],
  ];
  for (const [pattern, text, expected] of rows) {
    assert.equal(patternMatches(pattern, text), expected, `${pattern} vs ${text}`);
  }
});

test('commands split on operators but not inside quotes or redirects', () => {
  assert.deepEqual(splitCommand('a && b | c; d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitCommand('echo "a && b" 2>&1'), ['echo "a && b" 2>&1']);
  assert.deepEqual(allSubcommands('echo "$(git clean -f)"'), ['echo "$(git clean -f)"', 'git clean -f']);
  assert.deepEqual(allSubcommands('(cd x && rm -rf y)'), ['cd x', 'rm -rf y']);
  assert.deepEqual(allSubcommands('for d in a b; do rm -rf $d; done'), ['for d in a b', 'rm -rf $d']);
});

test('wrappers and assignments are stripped the way the docs describe', () => {
  assert.equal(stripWrappers('timeout 30 npm test').text, 'npm test');
  assert.equal(stripWrappers('nohup nice -n 5 npm test').text, 'npm test');
  assert.equal(stripWrappers('xargs grep pattern').text, 'grep pattern');
  assert.equal(stripWrappers('xargs -n1 grep pattern').text, 'xargs -n1 grep pattern');
  assert.equal(stripWrappers('command -v node').text, 'command -v node');
  assert.deepEqual(stripWrappers('NODE_ENV=test npm test'), { text: 'npm test', unsafeEnv: false });
  assert.deepEqual(stripWrappers('FOO=bar rm -rf tmp/'), { text: 'rm -rf tmp/', unsafeEnv: true });
});

test('with no rules, the mode decides', () => {
  assert.equal(verdict({ command: 'terraform destroy' }), 'asks');
  assert.equal(verdict({ command: 'terraform destroy', mode: 'bypassPermissions' }), 'runs');
  assert.equal(verdict({ command: 'terraform destroy', mode: 'dontAsk' }), 'blocked');
  assert.equal(verdict({ command: 'terraform destroy', mode: 'auto' }), 'unknown');
  assert.equal(verdict({ command: 'ls -la' }), 'runs');
  assert.equal(verdict({ command: 'cat a > b' }), 'asks');
});

test('deny rules hold in bypass mode but miss other spellings', () => {
  const permissions = { deny: ['Bash(terraform destroy *)', 'Bash(rm *)'] };
  const yolo = (command) => verdict({ command, mode: 'bypassPermissions', permissions });
  assert.equal(yolo('terraform destroy -auto-approve'), 'blocked');
  assert.equal(yolo('cd infra && terraform destroy'), 'blocked');
  assert.equal(yolo('bash -c "terraform destroy -auto-approve"'), 'runs');
  assert.equal(yolo('FOO=bar rm -rf tmp/'), 'blocked');
  assert.equal(yolo('echo "$(rm -rf y)"'), 'blocked');
  assert.equal(yolo('/bin/rm -rf build/'), 'runs');
});

test('allow rules must cover every part of a command', () => {
  const permissions = { allow: ['Bash(npm *)', 'Bash(devbox run *)', 'Bash(find *)'] };
  const run = (command) => verdict({ command, permissions });
  assert.equal(run('npm run db:push'), 'runs');
  assert.equal(run('npm test && rm -rf x'), 'asks');
  assert.equal(run('FOO=1 npm test'), 'asks');
  assert.equal(run('devbox run rm -rf .'), 'runs');
  assert.equal(run('find . -name x -delete'), 'asks');
  assert.equal(run('cd src && npm test'), 'runs');
});

test('ask rules and the critical-path check prompt in every mode', () => {
  const permissions = { ask: ['Bash(git push *)'], allow: ['Bash(git *)', 'Bash(rm *)'] };
  assert.equal(verdict({ command: 'git push origin main', mode: 'bypassPermissions', permissions }), 'asks');
  assert.equal(verdict({ command: 'rm -rf tests/ ~/', mode: 'bypassPermissions' }), 'asks');
  assert.equal(verdict({ command: 'rm -rf tests/ ~/', permissions }), 'asks');
  assert.equal(verdict({ command: 'rm -rf tests/ ~/', mode: 'dontAsk', permissions }), 'blocked');
  assert.equal(verdict({ command: 'rm -rf build', permissions }), 'runs');
});

test('hooks can block or approve, but never beat a deny or ask rule', () => {
  const deny = { decision: 'deny', reason: 'no' };
  const allow = { decision: 'allow' };
  assert.equal(verdict({ command: 'x', mode: 'bypassPermissions', hook: deny }), 'blocked');
  assert.equal(verdict({ command: 'x', hook: allow }), 'runs');
  assert.equal(verdict({ command: 'x', hook: allow, permissions: { deny: ['Bash(x)'] } }), 'blocked');
  assert.equal(verdict({ command: 'x', hook: allow, permissions: { ask: ['Bash(x)'] } }), 'asks');
  assert.equal(verdict({ command: 'x', mode: 'bypassPermissions', hook: { decision: 'ask' } }), 'asks');
});

test('acceptEdits approves file commands only inside the project', () => {
  assert.equal(verdict({ command: 'rm -rf build', mode: 'acceptEdits' }), 'runs');
  assert.equal(verdict({ command: 'rm -rf ../shared-assets', mode: 'acceptEdits' }), 'asks');
  assert.equal(verdict({ command: 'npm test', mode: 'acceptEdits' }), 'asks');
});

test('PowerShell rules ignore case', () => {
  const permissions = { deny: ['PowerShell(Remove-Item *)'] };
  const input = { tool: 'PowerShell', mode: 'bypassPermissions', permissions };
  assert.equal(verdict({ ...input, command: 'remove-item -Recurse build' }), 'blocked');
  assert.equal(verdict({ ...input, command: 'Get-ChildItem' }), 'runs');
  assert.equal(verdict({ tool: 'PowerShell', mode: 'bypassPermissions', command: 'Remove-Item -Recurse -Force D:\\' }), 'asks');
});
