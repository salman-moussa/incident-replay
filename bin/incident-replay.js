#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadIncidents } from '../src/claude.js';
import { replayAll } from '../src/run.js';
import { htmlMuseum, htmlReport, terminalSummary } from '../src/report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = 'incident-replay-guard.mjs';
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'run';
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) && args[args.indexOf(name) + 1]) || fallback;

const HELP = `incident-replay: replay real AI agent incidents against your Claude Code, Codex and Cursor setup. Nothing is executed.

  incident-replay                 test your setup and write incident-replay-report.html
      --cwd <dir>           project folder to test (default: current folder)
      --agents <list>       claude,codex,cursor (default: every one found on this machine)
      --out <file>          where to write the report
      --open                open the report in your browser
      --json                print the result as JSON instead
      --no-hooks            do not replay your hooks
  incident-replay fix             install the guard hook for Claude Code (backs up settings.json first)
  incident-replay unfix           remove the guard hook
  incident-replay museum          write the incident museum page (--out site/index.html)
  incident-replay list            list the incidents
`;

const COLOUR = { ok: 32, bad: 31 };
const paint = (text, tone) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${COLOUR[tone]}m${text}\x1b[0m` : text);

function open(file) {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

async function run() {
  const cwd = resolve(value('--cwd', process.cwd()));
  const incidents = loadIncidents();
  const agents = value('--agents', '').split(',').map((a) => a.trim()).filter(Boolean);
  const json = flag('--json');
  const progress = process.stderr.isTTY && !json
    ? (done, total) => process.stderr.write(`\r  replaying ${done}/${total}`) : () => {};
  const report = await replayAll({ cwd, incidents, agents, useHooks: !flag('--no-hooks'), onProgress: progress });
  if (process.stderr.isTTY && !json) process.stderr.write('\r\x1b[K');
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(terminalSummary(report, paint));
  const out = resolve(value('--out', 'incident-replay-report.html'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, htmlReport(report));
  console.log(`\nReport: ${out}`);
  if (flag('--open')) open(out);
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    console.error(`Stopped: ${path} is not valid JSON (${error.message}). Nothing was changed.`);
    process.exit(1);
  }
}

const usesGuard = (group) => (group.hooks || []).some((h) => String(h.command).includes(GUARD));

function writeSettings(path, settings) {
  if (existsSync(path)) {
    const backup = `${path}.incident-replay-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
    console.log(`Backup:  ${backup}`);
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function fix() {
  const dir = configDir();
  const settingsPath = join(dir, 'settings.json');
  const target = join(dir, 'hooks', GUARD);
  const settings = readSettings(settingsPath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(ROOT, 'guard', GUARD), target);
  console.log(`Guard:   ${target}`);
  const groups = settings.hooks?.PreToolUse || [];
  if (groups.some(usesGuard)) return console.log('The guard hook is already in settings.json. The guard file was refreshed.');
  settings.hooks = {
    ...settings.hooks,
    PreToolUse: [...groups, {
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: `node "${target.replace(/\\/g, '/')}"`, timeout: 10 }],
    }],
  };
  writeSettings(settingsPath, settings);
  console.log(`Updated: ${settingsPath}\nRestart Claude Code, then run incident-replay again. Undo with: incident-replay unfix`);
}

function unfix() {
  const dir = configDir();
  const settingsPath = join(dir, 'settings.json');
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.PreToolUse || [];
  if (groups.some(usesGuard)) {
    const kept = groups.filter((g) => !usesGuard(g));
    if (kept.length) settings.hooks.PreToolUse = kept;
    else delete settings.hooks.PreToolUse;
    writeSettings(settingsPath, settings);
    console.log(`Updated: ${settingsPath}`);
  } else {
    console.log('The guard hook is not in settings.json.');
  }
  rmSync(join(dir, 'hooks', GUARD), { force: true });
}

function museum() {
  const out = resolve(value('--out', join('site', 'index.html')));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, htmlMuseum(loadIncidents()));
  console.log(`Museum: ${out}`);
}

function list() {
  for (const i of loadIncidents()) {
    console.log(`${i.date.padEnd(10)}  ${i.agent.padEnd(18)}  ${String(i.scenarios.length).padStart(2)} scenarios  ${i.title}`);
  }
}

const commands = { run, fix, unfix, museum, list };
if (flag('--help') || flag('-h') || command === 'help') {
  console.log(HELP);
} else if (flag('--version')) {
  console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
} else if (commands[command]) {
  try {
    await commands[command]();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}
