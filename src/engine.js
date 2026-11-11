// The verdict model: what Claude Code would do with one command, given permission rules,
// a permission mode and the answer of the PreToolUse hooks. Pure functions, no I/O.
// It follows the published Claude Code permission docs. It is a model, not Claude Code itself.

import { allSubcommands, stripWrappers } from './shell.js';
import { removesCriticalPath, tokens } from '../guard/incident-replay-guard.mjs';

const READ_ONLY = new Set(['ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'find', 'wc', 'which', 'diff', 'stat', 'du', 'cd']);
const GIT_READ_ONLY = /^git\s+(?:status|log|diff|show|rev-parse|ls-files|blame)\b/;
const FIND_ACTION = /\s-(?:exec|execdir|ok|okdir|delete|rm|fprint|fprintf|fls|files0-from)\b/;
const EXEC_WRAPPER = /^(?:watch|setsid|ionice|flock)\s/;
const FILE_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);
const WRITES_FILE = />(?!&)\s*(?!\/dev\/null\b)\S/;

/** "Bash(rm *)" -> { tool: 'Bash', pattern: 'rm *' }. A bare tool name or Tool(*) matches every command. */
export function parseRule(rule) {
  const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(String(rule).trim());
  if (!m) return null;
  return { raw: String(rule), tool: m[1], pattern: m[2] === undefined || m[2] === '*' ? null : m[2] };
}

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Claude Code wildcard matching: `*` is any text, a lone trailing ` *` also matches the bare command, `:*` is ` *`. */
export function patternMatches(pattern, text, caseInsensitive = false) {
  const p = pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern;
  const loneTrailing = p.endsWith(' *') && p.indexOf('*') === p.length - 1;
  const source = loneTrailing ? `${escape(p.slice(0, -2))}(?: .*)?` : p.split('*').map(escape).join('.*');
  return new RegExp(`^${source}$`, caseInsensitive ? 'si' : 's').test(text);
}

function rulesFor(list, tool, toolGlobs) {
  return (list || []).map(parseRule).filter((r) => {
    if (!r) return false;
    if (r.tool === tool) return true;
    return toolGlobs && r.tool.includes('*') && patternMatches(r.tool, tool);
  });
}

function isReadOnly(text) {
  if (WRITES_FILE.test(text)) return false;
  const first = tokens(text)[0]?.text;
  if (first === 'find') return !FIND_ACTION.test(text);
  return READ_ONLY.has(first) || GIT_READ_ONLY.test(text);
}

function staysInProject(text) {
  const words = tokens(text).map((w) => w.text);
  if (!FILE_COMMANDS.has(words[0])) return false;
  return !words.slice(1).some((w) => /^(?:\/|~|\.\.|\$|[A-Za-z]:)/.test(w));
}

/** True when `command` (or a part of it) matches a hook `if` rule such as "Bash(rm *)". */
export function ruleMatchesCommand(rule, tool, command) {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== tool) return false;
  if (parsed.pattern === null) return true;
  const ci = tool === 'PowerShell';
  return allSubcommands(command, { backslash: !ci })
    .some((s) => patternMatches(parsed.pattern, stripWrappers(s).text, ci));
}

/**
 * @param {object} input
 * @param {string} input.command
 * @param {'Bash'|'PowerShell'} [input.tool]
 * @param {string} [input.mode] default | acceptEdits | plan | auto | dontAsk | bypassPermissions
 * @param {{allow?: string[], deny?: string[], ask?: string[]}} [input.permissions]
 * @param {{decision: 'deny'|'ask'|'allow', reason?: string}|null} [input.hook] merged hook answer
 * @returns {{verdict: 'blocked'|'asks'|'runs'|'unknown', by: string}}
 */
export function evaluate({ command, tool = 'Bash', mode = 'default', permissions = {}, hook = null }) {
  const ci = tool === 'PowerShell';
  const subs = allSubcommands(command, { backslash: !ci }).map((raw) => ({ raw, ...stripWrappers(raw) }));
  const prompt = (by) => (mode === 'dontAsk' ? { verdict: 'blocked', by: `${by} (dontAsk mode denies instead of asking)` } : { verdict: 'asks', by });

  // Deny and ask rules look at the whole text and at every part, past wrappers and assignments.
  const anywhere = [command.trim(), ...subs.flatMap((s) => [s.raw, s.text])];
  const findRule = (list) => rulesFor(list, tool, true)
    .find((r) => r.pattern === null || anywhere.some((t) => patternMatches(r.pattern, t, ci)));

  const denied = findRule(permissions.deny);
  if (denied) return { verdict: 'blocked', by: `deny rule ${denied.raw}` };
  if (hook?.decision === 'deny') return { verdict: 'blocked', by: `hook: ${hook.reason || 'denied'}` };

  const asked = findRule(permissions.ask);
  if (asked) return prompt(`ask rule ${asked.raw}`);
  if (subs.some((s) => removesCriticalPath(tokens(s.text).map((w) => w.text)))) {
    return prompt('Claude Code built-in check for removing a critical path');
  }
  if (hook?.decision === 'ask') return prompt(`hook: ${hook.reason || 'asks'}`);
  if (hook?.decision === 'allow') return { verdict: 'runs', by: `hook approved it: ${hook.reason || 'no reason given'}` };

  if (mode === 'bypassPermissions') return { verdict: 'runs', by: 'bypass mode skips the permission prompt' };

  // An allow rule must cover every part. Wildcard rules cannot approve exec wrappers or find actions.
  const allowRules = rulesFor(permissions.allow, tool, false);
  const allowedBy = (s) => {
    const text = s.unsafeEnv ? s.raw : s.text;
    const needsExact = EXEC_WRAPPER.test(text) || (/^find\s/.test(text) && FIND_ACTION.test(text));
    return allowRules.find((r) => {
      if (r.pattern === null) return !needsExact;
      if (needsExact && r.pattern.includes('*')) return false;
      return patternMatches(r.pattern, text, ci);
    });
  };
  const fileCommandsOk = mode === 'acceptEdits' && tool === 'Bash';
  let reason = '';
  const covered = subs.length > 0 && subs.every((s) => {
    if (tool === 'Bash' && isReadOnly(s.text)) return true;
    const rule = allowedBy(s);
    if (rule) { reason ||= `allow rule ${rule.raw}`; return true; }
    if (fileCommandsOk && staysInProject(s.text)) { reason ||= 'acceptEdits mode approves file commands inside the project'; return true; }
    return false;
  });
  if (covered) return { verdict: 'runs', by: reason || 'read-only command, never prompts' };

  if (mode === 'dontAsk') return { verdict: 'blocked', by: 'dontAsk mode denies anything not pre-approved' };
  if (mode === 'plan') return { verdict: 'blocked', by: 'plan mode does not run commands' };
  if (mode === 'auto') return { verdict: 'unknown', by: 'auto mode: a classifier decides, which cannot be replayed offline' };
  return { verdict: 'asks', by: 'no rule covers it, so Claude Code asks you' };
}
