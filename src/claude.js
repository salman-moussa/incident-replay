// Reads a real Claude Code setup (settings files, plugin hooks), sends simulated tool
// calls to its PreToolUse hooks, and scores every incident scenario.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, ruleMatchesCommand } from './engine.js';
import { decide } from '../guard/crashtest-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODE_ORDER = ['user', 'project', 'local', 'managed'];
const RANK = { deny: 3, ask: 2, allow: 1 };

function readJson(path, warnings) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    warnings.push(`Could not read ${path}: ${error.message}`);
    return null;
  }
}

function managedPath() {
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function handlers(hooks, source, pluginRoot) {
  const out = [];
  for (const group of hooks?.PreToolUse || []) {
    for (const h of group.hooks || []) out.push({ ...h, matcher: group.matcher, source, pluginRoot });
  }
  return out;
}

function pluginHooks(dir, enabled, warnings) {
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json'), warnings)?.plugins || {};
  const out = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const entry = [].concat(installed[id] || [])[0];
    if (!entry?.installPath) continue;
    const manifest = readJson(join(entry.installPath, '.claude-plugin', 'plugin.json'), warnings);
    // ponytail: one hooks file per plugin (manifest path, inline object, or hooks/hooks.json).
    let hooks = manifest?.hooks;
    if (typeof hooks === 'string') hooks = readJson(resolve(entry.installPath, hooks), warnings);
    if (!hooks) hooks = readJson(join(entry.installPath, 'hooks', 'hooks.json'), warnings);
    out.push(...handlers(hooks?.hooks || hooks, `plugin ${id}`, entry.installPath));
  }
  return out;
}

/** Load and merge the settings Claude Code would use in `cwd`. */
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const warnings = [];
  const dir = configDir(env);
  const candidates = [
    ['user', join(dir, 'settings.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')],
    ['managed', managedPath()],
  ];
  const seen = new Set();
  const config = {
    cwd, dir, files: [], warnings, mode: 'default', bypassDisabled: false, hooksDisabled: false,
    permissions: { allow: [], deny: [], ask: [] }, hooks: [],
  };
  let enabled = {};
  for (const [scope, path] of candidates) {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const json = readJson(path, warnings);
    if (!json) continue;
    config.files.push({ scope, path });
    const p = json.permissions || {};
    for (const kind of ['allow', 'deny', 'ask']) config.permissions[kind].push(...(Array.isArray(p[kind]) ? p[kind] : []));
    // Project files cannot switch a session into auto or bypass mode.
    const shared = scope === 'project' || scope === 'local';
    if (p.defaultMode && !(shared && ['auto', 'bypassPermissions'].includes(p.defaultMode))) config.mode = p.defaultMode;
    if (p.disableBypassPermissionsMode === 'disable') config.bypassDisabled = true;
    if (typeof json.disableAllHooks === 'boolean') config.hooksDisabled = json.disableAllHooks;
    enabled = { ...enabled, ...(json.enabledPlugins || {}) };
    config.hooks.push(...handlers(json.hooks, `${scope} settings`));
  }
  config.hooks.push(...pluginHooks(dir, enabled, warnings));
  if (config.hooksDisabled) config.hooks = [];
  void MODE_ORDER;
  return config;
}

export function matcherMatches(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\-\s,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(tool);
  try { return new RegExp(matcher).test(tool); } catch { return false; }
}

function bashPath(env) {
  if (process.platform !== 'win32') return 'bash';
  const known = [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  return known.find((p) => p && existsSync(p)) || 'bash';
}

function launch(h, cwd, env) {
  const options = { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  const fill = (s) => String(s).replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT)\}/g, (_, k) => env[k] ?? '');
  if (Array.isArray(h.args)) return spawn(fill(h.command), h.args.map(fill), options);
  if (h.shell === 'powershell') return spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', h.command], options);
  return spawn(bashPath(env), ['-c', h.command], options);
}

function readAnswer(code, stdout, stderr) {
  if (code === 2) return { decision: 'deny', reason: stderr.trim().split('\n')[0] || 'exit code 2' };
  let json;
  try { json = JSON.parse(stdout); } catch { return null; }
  if (json?.continue === false) return { decision: 'deny', reason: json.stopReason || 'hook stopped the session' };
  const specific = json?.hookSpecificOutput;
  if (['deny', 'ask', 'allow'].includes(specific?.permissionDecision)) {
    return { decision: specific.permissionDecision, reason: String(specific.permissionDecisionReason || '').split('\n')[0] };
  }
  // Deprecated top-level form, still mapped by Claude Code.
  if (json?.decision === 'block') return { decision: 'deny', reason: String(json.reason || '').split('\n')[0] };
  if (json?.decision === 'approve') return { decision: 'allow', reason: String(json.reason || '').split('\n')[0] };
  return null;
}

function runHandler(h, payload, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    let child;
    try {
      child = launch(h, cwd, { ...env, CLAUDE_PROJECT_DIR: cwd, ...(h.pluginRoot ? { CLAUDE_PLUGIN_ROOT: h.pluginRoot } : {}) });
    } catch (error) {
      return done({ error: `${h.source}: ${error.message}` });
    }
    let stdout = '', stderr = '';
    const limit = Math.min((h.timeout || 600) * 1000, timeoutMs);
    const timer = setTimeout(() => { child.kill(); done({ error: `${h.source}: no answer in ${limit / 1000}s` }); }, limit);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); done({ error: `${h.source}: ${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); done({ answer: readAnswer(code, stdout, stderr), source: h.source }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Ask every matching PreToolUse hook about one simulated call. deny > ask > allow, as in Claude Code. */
export async function askHooks(config, { tool, command, mode, sessionId = 'crashtest' }, { env = process.env, timeoutMs = 15000 } = {}) {
  const result = { decision: null, reason: '', ran: 0, skipped: 0, errors: [] };
  const jobs = [];
  for (const h of config.hooks) {
    if (!matcherMatches(h.matcher, tool)) continue;
    if (h.type !== 'command') { result.skipped++; continue; }
    if (h.if && !ruleMatchesCommand(h.if, tool, command)) continue;
    const payload = {
      session_id: sessionId, transcript_path: '', cwd: config.cwd, permission_mode: mode,
      hook_event_name: 'PreToolUse', tool_name: tool,
      tool_input: { command, description: 'crashtest simulated call, never executed' },
      tool_use_id: 'toolu_crashtest',
    };
    jobs.push(runHandler(h, payload, { cwd: config.cwd, env, timeoutMs }));
  }
  for (const r of await Promise.all(jobs)) {
    result.ran++;
    if (r.error) { result.errors.push(r.error); continue; }
    if (r.answer && (RANK[r.answer.decision] || 0) > (RANK[result.decision] || 0)) {
      result.decision = r.answer.decision;
      result.reason = `${r.source}${r.answer.reason ? `: ${r.answer.reason}` : ''}`;
    }
  }
  return result;
}

/** Load every incident file, sorted by date. */
export function loadIncidents(dir = join(ROOT, 'incidents')) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const stronger = (a, b) => ((RANK[b?.decision] || 0) > (RANK[a?.decision] || 0) ? b : a);

/**
 * Replay every scenario. Each one gets three verdicts: the configured mode, bypass mode
 * ("YOLO"), and bypass mode with the crashtest guard added. Nothing is executed.
 */
export async function crashTest({ config, incidents, useHooks = true, env = process.env, onProgress = () => {} }) {
  const report = {
    generatedAt: new Date().toISOString(), mode: config.mode, bypassDisabled: config.bypassDisabled,
    files: config.files, warnings: [...config.warnings], hookCount: config.hooks.length, hooksUsed: useHooks,
    skippedHooks: 0, retryOnly: 0, hookErrors: [], incidents: [],
    totals: { scenarios: 0, normal: {}, yolo: {}, guarded: {} },
  };
  const count = (bucket, verdict) => { bucket[verdict] = (bucket[verdict] || 0) + 1; };
  const all = incidents.flatMap((incident) => incident.scenarios.map((scenario) => ({ incident, scenario })));
  // A fresh id per run, so hooks that keep per-session state see a new session each time.
  const sessionId = `crashtest-${randomUUID()}`;
  const results = new Map();

  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const { scenario } = all[next++];
      const tool = scenario.tool || 'Bash';
      const call = { tool, command: scenario.command, permissions: config.permissions };
      // ponytail: hooks are asked once, with the configured mode in the payload, and that
      // answer is reused for bypass mode. Ask twice if hooks start branching on the mode.
      const ask = () => askHooks(config, { tool, command: scenario.command, mode: config.mode, sessionId }, { env });
      let asked = useHooks ? await ask() : { decision: null, skipped: 0, errors: [] };
      // Some hooks refuse a command once and let the retry through. An agent retries,
      // so the second answer is the one that counts.
      if (asked.decision === 'deny') {
        const retry = await ask();
        if (retry.decision !== 'deny') {
          report.retryOnly++;
          asked = { ...retry, firstTryOnly: asked.reason };
        }
      }
      report.skippedHooks = Math.max(report.skippedHooks, asked.skipped);
      for (const e of asked.errors) if (!report.hookErrors.includes(e)) report.hookErrors.push(e);
      const hook = asked.decision ? asked : null;
      const guard = decide(scenario.command, 'bypassPermissions');
      const guardHook = guard && { decision: guard.decision, reason: `crashtest guard: ${guard.why}` };
      results.set(scenario, {
        normal: evaluate({ ...call, mode: config.mode, hook }),
        yolo: evaluate({ ...call, mode: 'bypassPermissions', hook }),
        guarded: evaluate({ ...call, mode: 'bypassPermissions', hook: stronger(hook, guardHook) }),
      });
      onProgress(results.size, all.length);
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));

  for (const incident of incidents) {
    const scenarios = incident.scenarios.map((scenario) => {
      const verdicts = results.get(scenario);
      report.totals.scenarios++;
      for (const key of ['normal', 'yolo', 'guarded']) count(report.totals[key], verdicts[key].verdict);
      return { ...scenario, ...verdicts };
    });
    report.incidents.push({ ...incident, scenarios });
  }
  return report;
}
