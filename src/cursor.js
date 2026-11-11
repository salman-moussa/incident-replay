// Cursor adapter: CLI permissions (Shell allow and deny lists) and beforeShellExecution hooks.
// It follows the Cursor CLI permissions and hooks docs.
// ponytail: the IDE's own auto-run allow list lives in the app's state database and is
// not read. Add it when Cursor documents a stable place for it.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runHandler } from './claude.js';
import { patternMatches } from './engine.js';
import { allSubcommands } from './shell.js';
import { tokens } from '../guard/incident-replay-guard.mjs';

export const cursorDir = (env = process.env) => env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor');

const RANK = { deny: 3, ask: 2, allow: 1 };

function readJson(path, notes) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    notes.push(`Could not read ${path}: ${error.message}`);
    return null;
  }
}

/** "Shell(git)" -> { base: 'git' }, "Shell(curl:*)" -> { base: 'curl', args: '*' }. Other tokens are ignored. */
export function shellRules(list) {
  return (Array.isArray(list) ? list : []).flatMap((token) => {
    const m = /^Shell\((.+)\)$/.exec(String(token).trim());
    if (!m) return [];
    const cut = m[1].indexOf(':');
    return [cut < 0 ? { base: m[1] } : { base: m[1].slice(0, cut), args: m[1].slice(cut + 1) }];
  });
}

function matches(rule, sub) {
  const words = tokens(sub).map((w) => w.text);
  if (!words.length || !patternMatches(rule.base, words[0])) return false;
  return rule.args === undefined || patternMatches(rule.args, words.slice(1).join(' '));
}

/**
 * @param {object} input
 * @param {string} input.command
 * @param {{base: string, args?: string}[]} [input.deny]
 * @param {{base: string, args?: string}[]} [input.allow]
 * @param {{decision: 'deny'|'ask'|'allow', reason?: string}|null} [input.hook]
 * @param {boolean} [input.yolo] --force: run anything that is not denied
 */
export function evaluateCursor({ command, deny = [], allow = [], hook = null, yolo = false }) {
  const subs = allSubcommands(command);
  const denied = deny.find((rule) => subs.some((sub) => matches(rule, sub)));
  if (denied) return { verdict: 'blocked', by: `deny rule Shell(${denied.base}${denied.args === undefined ? '' : `:${denied.args}`})` };
  if (hook?.decision === 'deny') return { verdict: 'blocked', by: `hook: ${hook.reason || 'denied'}` };
  if (hook?.decision === 'ask') return { verdict: 'asks', by: `hook: ${hook.reason || 'asks'}` };
  if (hook?.decision === 'allow') return { verdict: 'runs', by: 'a hook approved it' };
  if (yolo) return { verdict: 'runs', by: '--force runs anything that is not denied' };
  if (subs.length && subs.every((sub) => allow.some((rule) => matches(rule, sub)))) return { verdict: 'runs', by: 'the allow list covers it' };
  return { verdict: 'asks', by: 'it is not in the allow list, so Cursor asks you' };
}

function readAnswer(result, hook) {
  const failed = (why) => (hook.failClosed ? { decision: 'deny', reason: `the hook failed and is set to fail closed (${why})` } : null);
  if (result.error) return failed(result.error);
  if (result.code === 2) return { decision: 'deny', reason: result.stderr.trim().split('\n')[0] || 'exit code 2' };
  if (result.code !== 0) return failed(`exit code ${result.code}`);
  if (!result.stdout.trim()) return null;
  let json;
  try { json = JSON.parse(result.stdout); } catch { return { decision: 'deny', reason: 'the hook printed invalid JSON, which Cursor treats as a block' }; }
  if (!RANK[json?.permission]) return null;
  return { decision: json.permission, reason: String(json.user_message || json.agent_message || '').split('\n')[0] };
}

async function askHooks(hooks, command, cwd, env) {
  let best = null;
  for (const hook of hooks) {
    if (hook.matcher) {
      try { if (!new RegExp(hook.matcher).test(command)) continue; } catch { continue; }
    }
    const payload = {
      hook_event_name: 'beforeShellExecution', command, cwd, sandbox: false,
      conversation_id: 'incident-replay', generation_id: 'incident-replay', workspace_roots: [cwd],
    };
    const result = await runHandler({ command: hook.command, timeout: hook.timeout, source: 'cursor hook' }, payload, { cwd: hook.cwd, env, timeoutMs: 15000 });
    const answer = readAnswer(result, hook);
    if (answer && RANK[answer.decision] > (RANK[best?.decision] || 0)) best = answer;
  }
  return best;
}

/** Verdicts for every scenario under the Cursor setup found on this machine. */
export async function cursorAgent({ cwd, env = process.env, incidents, useHooks = true }) {
  const dir = cursorDir(env);
  const notes = [];
  const files = [join(dir, 'cli-config.json'), join(cwd, '.cursor', 'cli.json')];
  const configs = files.map((path) => readJson(path, notes)).filter(Boolean);
  const deny = configs.flatMap((c) => shellRules(c.permissions?.deny));
  const allow = configs.flatMap((c) => shellRules(c.permissions?.allow));
  const hooks = [[join(dir, 'hooks.json'), dir], [join(cwd, '.cursor', 'hooks.json'), cwd]].flatMap(([path, hookCwd]) =>
    (readJson(path, notes)?.hooks?.beforeShellExecution || []).filter((h) => h?.command).map((h) => ({ ...h, cwd: hookCwd })));

  notes.unshift(`${allow.length} allow and ${deny.length} deny Shell rule(s), ${hooks.length} shell hook(s)${useHooks ? '' : ' (not replayed)'}.`);
  notes.push('This covers Cursor CLI permissions and hooks. The auto-run list inside the Cursor app is not read.');

  const verdicts = new Map();
  for (const scenario of incidents.flatMap((i) => i.scenarios)) {
    const hook = useHooks && hooks.length ? await askHooks(hooks, scenario.command, cwd, env) : null;
    const call = { command: scenario.command, deny, allow, hook };
    verdicts.set(scenario, { normal: evaluateCursor(call), yolo: evaluateCursor({ ...call, yolo: true }) });
  }
  return { id: 'cursor', name: 'Cursor', mode: 'ask unless allowed', yoloName: '--force', hasGuard: false, notes, verdicts };
}
