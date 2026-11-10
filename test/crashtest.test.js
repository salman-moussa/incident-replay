import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, isCriticalPath, judge } from '../guard/crashtest-guard.mjs';
import { askHooks, loadConfig, loadIncidents, matcherMatches } from '../src/claude.js';
import { htmlMuseum, htmlReport, terminalSummary } from '../src/report.js';
import { crashTest, detectAgents } from '../src/run.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'crashtest.js');
const GUARD = join(ROOT, 'guard', 'crashtest-guard.mjs');
const incidents = loadIncidents();
const scenarios = incidents.flatMap((i) => i.scenarios);
const slash = (p) => p.replace(/\\/g, '/');

/** A throwaway config folder and project, so no test touches the real setup of any agent. */
function sandbox(settings = {}) {
  const base = mkdtempSync(join(tmpdir(), 'crashtest-'));
  const home = join(base, 'claude');
  const cwd = join(base, 'project');
  mkdirSync(home);
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(base, 'codex'), CURSOR_CONFIG_DIR: join(base, 'cursor') };
  return { base, home, cwd, env };
}

const cli = (box, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: box.cwd, env: box.env, encoding: 'utf8' });
const find = (report, id) => report.incidents.flatMap((i) => i.scenarios).find((s) => s.id === id);

test('incident files are complete and sourced', () => {
  assert.ok(incidents.length >= 14);
  const ids = new Set();
  for (const i of incidents) {
    assert.ok(existsSync(join(ROOT, 'incidents', `${i.id}.json`)), `${i.id}: file name must match id`);
    assert.ok(!ids.has(i.id)); ids.add(i.id);
    assert.match(i.date, /^\d{4}-\d{2}(-\d{2})?$/, i.id);
    for (const key of ['agent', 'title', 'summary', 'lesson']) assert.ok(i[key]?.length > 3, `${i.id}.${key}`);
    assert.ok(i.sources.length >= 2, `${i.id}: at least two sources`);
    for (const s of i.sources) assert.match(s.url, /^https:\/\//, i.id);
    assert.ok(i.scenarios.length >= 1);
    for (const s of i.scenarios) {
      assert.ok(['reported', 'representative', 'variant'].includes(s.kind), `${i.id}/${s.id}`);
      assert.ok(['outside', 'workspace', 'git', 'network'].includes(s.effect), `${i.id}/${s.id}: effect`);
      assert.ok(s.command && s.note && s.id);
      assert.ok(['Bash', 'PowerShell', undefined].includes(s.tool));
    }
  }
  assert.equal(readdirSync(join(ROOT, 'incidents')).length, incidents.length);
});

test('the guard stops every scenario of every incident', () => {
  for (const s of scenarios) assert.ok(judge(s.command), `guard missed: ${s.command}`);
});

test('the guard leaves ordinary work alone', () => {
  const fine = [
    'npm test', 'git status', 'git push origin main', 'git push --force-with-lease', 'git checkout main',
    'rm -rf node_modules', 'rm -rf dist build', 'rm -rf /tmp/build-123', 'mv a.txt b.txt',
    'git commit -m "stop using rm -rf ~/ in scripts"', 'echo "terraform destroy is dangerous"',
    'terraform plan', 'aws s3 ls', 'curl https://example.com', 'docker compose down',
    'kubectl get pods', 'psql -c "SELECT * FROM users"', 'npx prisma migrate dev', 'ls ~',
  ];
  for (const command of fine) assert.equal(judge(command), null, `false alarm: ${command}`);
});

test('wiping a critical path is denied, the rest asks, and ask becomes deny when nobody is watching', () => {
  assert.equal(judge('sudo rm -rf /').decision, 'deny');
  assert.equal(judge('ssh box "rm -rf ~"').decision, 'deny');
  assert.equal(judge('terraform destroy').decision, 'ask');
  assert.equal(decide('terraform destroy', 'default').decision, 'ask');
  assert.equal(decide('terraform destroy', 'bypassPermissions').decision, 'deny');
  assert.equal(decide('npm test', 'bypassPermissions'), null);
  for (const p of ['/', '~', '~/', '~/*', '$HOME', 'd:\\', 'C:/', '/usr', 'C:\\Users']) assert.ok(isCriticalPath(p), p);
  for (const p of ['', './build', '~/project/dist', '/tmp/x', '/s', '.']) assert.ok(!isCriticalPath(p), p);
});

test('the guard works as a real hook process', () => {
  const ask = (command, mode = 'default') => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', permission_mode: mode, tool_input: { command } }), encoding: 'utf8',
  });
  const blocked = ask('rm -rf tests/ patches/ plan/ ~/');
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(ask('git reset --hard').stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(ask('npm test').stdout, '');
  const broken = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
});

test('hook matchers follow the documented rules', () => {
  assert.ok(matcherMatches(undefined, 'Bash'));
  assert.ok(matcherMatches('*', 'Bash'));
  assert.ok(matcherMatches('Bash|PowerShell', 'PowerShell'));
  assert.ok(matcherMatches('Edit, Bash', 'Bash'));
  assert.ok(!matcherMatches('Edit|Write', 'Bash'));
  assert.ok(matcherMatches('^Ba', 'Bash'));
  assert.ok(matcherMatches('.*', 'Bash'));
});

test('Claude Code settings merge across files and real hooks are replayed', async () => {
  const box = sandbox({ permissions: { deny: ['Bash(git push *)'], defaultMode: 'acceptEdits' } });
  const hook = join(box.base, 'hook.mjs');
  writeFileSync(hook, `let s='';for await(const c of process.stdin)s+=c;
const cmd=JSON.parse(s).tool_input.command;
if(cmd.includes('destroy')){console.error('no destroy');process.exit(2)}
if(cmd.includes('reset'))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'sure?'}}));`);
  writeFileSync(join(box.cwd, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm *)'], defaultMode: 'bypassPermissions' },
    hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${slash(hook)}"` }, { type: 'prompt', prompt: 'x' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', if: 'Bash(never *)', command: 'exit 2' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'exit 2' }] },
    ] },
  }));
  const config = loadConfig({ cwd: box.cwd, env: box.env });
  assert.deepEqual(config.permissions.deny, ['Bash(git push *)']);
  assert.deepEqual(config.permissions.allow, ['Bash(npm *)']);
  assert.equal(config.mode, 'acceptEdits', 'a project file cannot switch on bypass mode');
  const ask = (command) => askHooks(config, { tool: 'Bash', command, mode: config.mode }, { env: box.env });
  const destroy = await ask('terraform destroy');
  assert.equal(destroy.decision, 'deny');
  assert.match(destroy.reason, /no destroy/);
  assert.equal(destroy.skipped, 1);
  assert.equal((await ask('git reset --hard')).decision, 'ask');
  assert.equal((await ask('npm test')).decision, null);

  const report = await crashTest({ cwd: box.cwd, env: box.env, incidents });
  assert.deepEqual(report.agents.map((a) => a.id), ['claude'], 'only the agent with a config folder is tested');
  assert.equal(report.scenarios, scenarios.length);
  assert.equal(find(report, 'destroy-auto-approve').verdicts.claude.yolo.verdict, 'blocked');
  assert.equal(find(report, 'reset-hard').verdicts.claude.yolo.verdict, 'asks');
  assert.equal(find(report, 'npm-db-push').verdicts.claude.normal.verdict, 'runs', 'the broad npm allow rule lets the schema push through');
  assert.equal(find(report, 'push-force').verdicts.claude.yolo.verdict, 'blocked', 'the deny rule holds in YOLO mode');
  assert.equal(find(report, 'push-with-option').verdicts.claude.yolo.verdict, 'runs', 'an option before push gets past the deny rule');
  assert.equal(report.agents[0].totals.guarded.runs || 0, 0, 'with the guard nothing runs unasked');
});

test('a hook that refuses only the first try does not count as protection', async () => {
  const box = sandbox();
  const hook = join(box.base, 'once.mjs');
  writeFileSync(hook, `import { existsSync, writeFileSync } from 'node:fs';
let s='';for await(const c of process.stdin)s+=c;
const seen=${JSON.stringify(slash(join(box.base, 'seen-')))}+Buffer.from(JSON.parse(s).tool_input.command).toString('hex').slice(0,40);
if(!existsSync(seen)){writeFileSync(seen,'');console.error('state your facts first');process.exit(2)}`);
  writeFileSync(join(box.home, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${slash(hook)}"` }] }] },
  }));
  const one = [{ ...incidents[0], scenarios: [{ id: 'x', command: 'terraform destroy', kind: 'variant', effect: 'network', note: 'n' }] }];
  const report = await crashTest({ cwd: box.cwd, env: box.env, incidents: one });
  assert.ok(report.agents[0].notes.some((note) => /refused once by a hook/.test(note)));
  assert.equal(report.incidents[0].scenarios[0].verdicts.claude.yolo.verdict, 'runs');
});

test('Codex and Cursor are found by their config folders and tested alongside Claude Code', async () => {
  const box = sandbox();
  assert.deepEqual(detectAgents(box.env), ['claude']);
  mkdirSync(join(box.env.CODEX_HOME, 'rules'), { recursive: true });
  writeFileSync(join(box.env.CODEX_HOME, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n');
  writeFileSync(join(box.env.CODEX_HOME, 'rules', 'default.rules'), 'prefix_rule(pattern=["terraform", "destroy"], decision="forbidden")\n');
  mkdirSync(box.env.CURSOR_CONFIG_DIR);
  const hook = join(box.base, 'cursor-hook.mjs');
  writeFileSync(hook, `let s='';for await(const c of process.stdin)s+=c;
if(JSON.parse(s).command.includes('volumeDelete'))console.log(JSON.stringify({permission:'deny',user_message:'no volume deletes'}));`);
  writeFileSync(join(box.env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Shell(git)'], deny: ['Shell(rm)'] } }));
  writeFileSync(join(box.env.CURSOR_CONFIG_DIR, 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [
    { command: `node "${slash(hook)}"` },
    { command: 'exit 1', matcher: 'reset', failClosed: true },
  ] } }));
  assert.deepEqual(detectAgents(box.env), ['claude', 'codex', 'cursor']);

  const report = await crashTest({ cwd: box.cwd, env: box.env, incidents });
  const [, codex, cursor] = report.agents;
  assert.equal(codex.mode, 'workspace-write, never');
  assert.equal(find(report, 'destroy').verdicts.codex.normal.verdict, 'blocked');
  assert.equal(find(report, 'destroy').verdicts.codex.yolo.verdict, 'unknown');
  assert.equal(find(report, 'clean').verdicts.codex.normal.verdict, 'runs', 'git clean stays inside the workspace, so the sandbox allows it');
  assert.equal(find(report, 'reset-hard').verdicts.codex.normal.verdict, 'blocked', '.git is read-only in the sandbox');
  assert.equal(find(report, 'home').verdicts.cursor.yolo.verdict, 'blocked', 'the Shell(rm) deny rule holds with --force');
  assert.equal(find(report, 'full-path-rm').verdicts.cursor.yolo.verdict, 'runs', '/bin/rm gets past Shell(rm)');
  assert.equal(find(report, 'graphql-volume-delete').verdicts.cursor.yolo.verdict, 'blocked', 'the hook denies it');
  assert.equal(find(report, 'reset-hard').verdicts.cursor.yolo.verdict, 'blocked', 'a failing hook set to fail closed blocks');
  assert.equal(find(report, 'checkout-dot').verdicts.cursor.normal.verdict, 'runs', 'Shell(git) allows every git command');
  assert.equal(cursor.totals.guarded.blocked, undefined, 'the guard is offered for Claude Code only');

  const html = htmlReport(report);
  for (const name of ['Claude Code', 'Codex', 'Cursor']) assert.ok(html.includes(`<h2>${name}</h2>`));
  assert.match(terminalSummary(report), /Codex\n {2}Your mode \(workspace-write, never\)/);
  await assert.rejects(() => crashTest({ cwd: box.cwd, env: box.env, incidents, agents: ['nope'] }), /Unknown agent/);
});

test('reports render every command safely', async () => {
  const box = sandbox();
  const report = await crashTest({ cwd: box.cwd, env: box.env, incidents });
  const totals = report.agents[0].totals;
  assert.equal(totals.normal.runs || 0, 0, 'default Claude Code asks or blocks everything here');
  assert.ok(totals.yolo.runs > 0, 'bypass mode with no rules lets most of it run');
  const html = htmlReport(report);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('psql &quot;$DATABASE_URL&quot;'));
  assert.ok(html.includes(`${report.scenarios} commands from ${incidents.length} public incidents`));
  assert.ok(htmlMuseum(incidents).includes(incidents[0].title));
  assert.match(terminalSummary(report), /YOLO mode \+ crashtest guard/);
});

test('the CLI runs, and fix and unfix change only the sandboxed settings', () => {
  const box = sandbox({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'true' }] }] } });
  const settingsPath = join(box.home, 'settings.json');

  const json = cli(box, 'run', '--json', '--no-hooks');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).scenarios, scenarios.length);

  const run = cli(box, '--out', join(box.base, 'out', 'report.html'));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(box.base, 'out', 'report.html')));

  const both = JSON.parse(cli(box, '--json', '--agents', 'codex,cursor').stdout);
  assert.deepEqual(both.agents.map((a) => a.id), ['codex', 'cursor'], 'agents can be chosen by hand');
  assert.equal(cli(box, '--agents', 'nope').status, 1);

  assert.equal(cli(box, 'fix').status, 0);
  assert.equal(cli(box, 'fix').status, 0);
  let settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.PreToolUse.length, 2, 'fix is idempotent and keeps existing hooks');
  assert.ok(existsSync(join(box.home, 'hooks', 'crashtest-guard.mjs')));
  assert.equal(readdirSync(box.home).filter((f) => f.includes('crashtest-backup')).length, 1);

  const after = JSON.parse(cli(box, 'run', '--json').stdout).agents[0];
  assert.equal(after.totals.yolo.runs || 0, 0, 'the installed guard is found and replayed as a real hook');
  assert.ok(!after.notes.some((note) => /Hook problem/.test(note)));

  assert.equal(cli(box, 'unfix').status, 0);
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.ok(!existsSync(join(box.home, 'hooks', 'crashtest-guard.mjs')));

  assert.equal(cli(box, 'museum', '--out', join(box.base, 'site', 'index.html')).status, 0);
  assert.equal(cli(box, 'list').stdout.trim().split('\n').length, incidents.length);
  assert.equal(cli(box, 'nonsense').status, 1);

  writeFileSync(settingsPath, '{ broken');
  const refused = cli(box, 'fix');
  assert.equal(refused.status, 1);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ broken', 'a broken settings file is never overwritten');
});
