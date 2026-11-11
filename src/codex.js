// Codex adapter. Codex protects with a sandbox more than with command rules, so a verdict
// depends on what a command touches (the scenario's `effect`) as well as on its text.
// It follows the Codex approvals and rules docs. The sandbox itself is never run.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitCommand } from './shell.js';
import { tokens } from '../guard/incident-replay-guard.mjs';

export const codexDir = (env = process.env) => env.CODEX_HOME || join(homedir(), '.codex');

const SHELLS = new Set(['bash', 'sh', 'zsh', 'powershell', 'pwsh']);
const RANK = { forbidden: 3, prompt: 2, allow: 1 };
// Codex only splits a script into separate commands when it is a plain chain of words.
const PLAIN = /^[^<>$`*?(){}=]*$/;
const WHY = {
  outside: 'it writes outside the workspace',
  git: 'the .git folder is read-only inside the sandbox',
  network: 'network access is off inside the sandbox',
  workspace: 'the sandbox is read-only',
};
const program = (word) => String(word).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
const norm = (path) => String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ponytail: reads `key = value` lines under `[section]` headers, which is all incident-replay
// needs from config.toml. Swap in a real TOML parser if it ever needs arrays or tables.
export function readToml(text) {
  const out = { top: {}, sections: {} };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { section = head[1]; out.sections[section] ||= {}; continue; }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
    (section ? out.sections[section] : out.top)[pair[1]] = value;
  }
  return out;
}

function listAt(text, start) {
  let depth = 0, quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Read prefix_rule(pattern=[...], decision="...") entries. Returns the rules and how many could not be read. */
export function parseRules(text) {
  const rules = [];
  let unread = 0;
  const starts = [...text.matchAll(/prefix_rule\s*\(/g)].map((m) => m.index);
  starts.forEach((start, n) => {
    const body = text.slice(start, starts[n + 1] ?? text.length);
    const at = /pattern\s*=\s*\[/.exec(body);
    const list = at && listAt(body, at.index + at[0].length - 1);
    let pattern;
    try { pattern = JSON.parse(list.replace(/,\s*\]/g, ']')); } catch { unread++; return; }
    const decision = /decision\s*=\s*["'](\w+)["']/.exec(body.replace(list, ''))?.[1] || 'allow';
    if (Array.isArray(pattern) && pattern.length && RANK[decision]) rules.push({ pattern, decision });
    else unread++;
  });
  return { rules, unread };
}

const prefixMatches = (pattern, argv) => pattern.length <= argv.length
  && pattern.every((p, i) => (Array.isArray(p) ? p.includes(argv[i]) : p === argv[i]));

/** The strictest rule decision for a command, or null when some part of it has no rule. */
export function ruleDecision(command, rules) {
  const words = tokens(command).map((w) => w.text);
  const wrapped = words.length === 3 && SHELLS.has(program(words[0])) && /^-(?:l?c|command)$/i.test(words[1]);
  const script = wrapped ? words[2] : command;
  const strictest = (hits) => hits.sort((a, b) => RANK[b.decision] - RANK[a.decision])[0]?.decision || null;
  // A rule saved for one exact script, such as ["powershell.exe", "-Command", "<script>"].
  const exact = strictest(rules.filter((r) => r.pattern.length >= 3 && SHELLS.has(program(r.pattern[0])) && r.pattern.at(-1) === script));
  if (!PLAIN.test(script)) return exact;
  const parts = splitCommand(script).map((part) => strictest(rules.filter((r) => prefixMatches(r.pattern, tokens(part).map((w) => w.text)))));
  if (parts.includes('forbidden') || exact === 'forbidden') return 'forbidden';
  if (parts.includes('prompt') || exact === 'prompt') return 'prompt';
  return exact === 'allow' || (parts.length > 0 && parts.every((d) => d === 'allow')) ? 'allow' : null;
}

/**
 * @param {object} input
 * @param {string} input.command
 * @param {'outside'|'workspace'|'git'|'network'} input.effect what the command touches
 * @param {string} input.approval approval_policy
 * @param {string} input.sandbox sandbox_mode
 * @param {boolean} [input.network] network_access inside workspace-write
 * @param {boolean} [input.yolo] --yolo: no sandbox, no approvals
 */
export function evaluateCodex({ command, effect, approval = 'on-request', sandbox = 'read-only', network = false, rules = [], yolo = false }) {
  const decision = ruleDecision(command, rules);
  if (yolo) {
    if (decision === 'forbidden') return { verdict: 'unknown', by: 'a forbidden rule matches, but the Codex docs do not say whether rules still apply with --yolo' };
    return { verdict: 'runs', by: '--yolo switches off the sandbox and the approvals' };
  }
  const cannotAsk = approval === 'never';
  if (decision === 'forbidden') return { verdict: 'blocked', by: 'a forbidden rule matches' };
  if (decision === 'prompt') return cannotAsk ? { verdict: 'blocked', by: 'a prompt rule matches and approval policy never cannot ask' } : { verdict: 'asks', by: 'a prompt rule matches' };
  if (decision === 'allow') return { verdict: 'runs', by: 'an allow rule matches, so it runs outside the sandbox' };
  if (approval === 'untrusted') return { verdict: 'asks', by: 'approval policy untrusted asks unless a rule allows it' };
  if (sandbox === 'danger-full-access') return { verdict: 'runs', by: 'sandbox mode danger-full-access has no limits' };
  const contained = sandbox === 'workspace-write' && (effect === 'workspace' || (effect === 'network' && network));
  if (contained) {
    return { verdict: 'runs', by: effect === 'network' ? 'network access is on inside the sandbox' : 'it only touches files inside the workspace, which the sandbox allows' };
  }
  const why = sandbox === 'read-only' ? WHY.workspace : WHY[effect];
  return cannotAsk
    ? { verdict: 'blocked', by: `the sandbox stops it (${why}) and approval policy never cannot ask` }
    : { verdict: 'asks', by: `the sandbox stops it (${why}), so Codex asks before running it outside` };
}

/** Verdicts for every scenario under the Codex setup found on this machine. */
export function codexAgent({ cwd, env = process.env, incidents }) {
  const dir = codexDir(env);
  const notes = [];
  const configPath = join(dir, 'config.toml');
  const toml = readToml(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
  const trusted = Object.entries(toml.sections).some(([name, keys]) => name.startsWith('projects.')
    && norm(name.slice(9).replace(/^(["'])(.*)\1$/, '$2')) === norm(cwd) && keys.trust_level === 'trusted');
  const approval = ['never', 'untrusted', 'on-request', 'on-failure'].includes(toml.top.approval_policy) ? toml.top.approval_policy : 'on-request';
  const sandbox = toml.top.sandbox_mode || (trusted ? 'workspace-write' : 'read-only');
  const network = toml.sections.sandbox_workspace_write?.network_access === 'true';

  const rules = [];
  let unread = 0;
  for (const folder of [join(dir, 'rules'), ...(trusted ? [join(cwd, '.codex', 'rules')] : [])]) {
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.rules'))) {
      const parsed = parseRules(readFileSync(join(folder, file), 'utf8'));
      rules.push(...parsed.rules);
      unread += parsed.unread;
    }
  }
  notes.push(existsSync(configPath) ? 'Config read: ~/.codex/config.toml.' : 'No config.toml found, so Codex defaults apply.');
  if (!toml.top.sandbox_mode) notes.push(`This folder is ${trusted ? 'a trusted project, so the sandbox defaults to workspace-write' : 'not a trusted project, so the sandbox defaults to read-only'}.`);
  notes.push(`${rules.length} command rule(s) read${unread ? `, ${unread} could not be read` : ''}.`);
  notes.push('Verdicts follow the sandbox model in the Codex docs. The sandbox itself is not run.');

  const verdicts = new Map();
  for (const scenario of incidents.flatMap((i) => i.scenarios)) {
    const call = { command: scenario.command, effect: scenario.effect, approval, sandbox, network, rules };
    verdicts.set(scenario, { normal: evaluateCodex(call), yolo: evaluateCodex({ ...call, yolo: true }) });
  }
  return { id: 'codex', name: 'Codex', mode: `${sandbox}, ${approval}`, yoloName: '--yolo', hasGuard: false, notes, verdicts };
}
