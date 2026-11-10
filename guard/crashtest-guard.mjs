#!/usr/bin/env node
// crashtest guard: a Claude Code PreToolUse hook. One file, no dependencies.
// It reads the tool call from stdin and answers deny, ask, or nothing.
// It never runs the command it is looking at.
//
// ponytail: pattern rules over a loose shell reader, not a sandbox. A command that
// hides its text (base64, a script written to disk then run) gets past it. Pair it
// with Claude Code sandboxing when the block has to hold.

import { basename } from 'node:path';

const REMOVERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred']);
const RECURSIVE = /^(?:-[a-z]*r[a-z]*|--recursive|\/s|-recurse)$/i;
// Tokens that mean "the quoted text that follows is itself a command".
const SHELL_TRIGGERS = new Set(['-c', '-lc', '-ic', '/c', '/k', '-command', 'eval', 'ssh', 'xargs', 'watch', '-exec', '-execdir']);
// Commands that only print their arguments. Text inside them is not a command.
const PRINTERS = new Set(['echo', 'printf', 'write-host', 'write-output']);
const SAFE_SCRATCH =/^(?:\/tmp\/|\/var\/folders\/|\$TMPDIR\b|\$\{TMPDIR\}|\$TEMP\b|\$env:TEMP\b)/i;

/** Split text into words. Quotes group words and are removed. No backslash escapes, so Windows paths survive. */
export function tokens(text) {
  const out = [];
  let cur = '', quote = null, quoted = false;
  const push = () => { if (cur || quoted) out.push({ text: cur, quoted }); cur = ''; quoted = false; };
  for (const c of text) {
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c;
  }
  push();
  return out;
}

/** True for a path whose removal wipes a machine: root, home, a drive, a system folder. */
export function isCriticalPath(arg) {
  if (!arg) return false;
  const p = arg.replace(/[)`}]+$/, '').replace(/\\/g, '/').replace(/\/\*$/, '').replace(/\/+$/, '');
  if (p === '' || p === '~' || /^[a-z]:$/i.test(p)) return true;
  if (/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)$/i.test(p)) return true;
  if (/^\/(?:usr|etc|var|bin|sbin|lib|opt|home|root|Users|System|Library|Applications)$/.test(p)) return true;
  return /^[a-z]:\/(?:Users|Windows|Program Files(?: \(x86\))?)$/i.test(p);
}

const program = (word) =>
  word.replace(/^[$(`{]+/, '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');

/** True when the words remove a critical path, wherever the remove command sits in them. */
export function removesCriticalPath(argv) {
  const at = argv.findIndex((w) => REMOVERS.has(program(w)));
  if (at >= 0 && argv.slice(at + 1).some(isCriticalPath)) return true;
  const find = argv.findIndex((w) => program(w) === 'find');
  if (find < 0) return false;
  const rest = argv.slice(find + 1);
  const deletes = rest.includes('-delete') || rest.some((w) => REMOVERS.has(program(w)));
  return deletes && rest.some(isCriticalPath);
}

function removesOutsideProject(argv) {
  const at = argv.findIndex((w) => REMOVERS.has(program(w)));
  if (at < 0) return false;
  const rest = argv.slice(at + 1);
  if (!rest.some((w) => RECURSIVE.test(w))) return false;
  return rest.some((w) => /^(?:\.\.|\/[^/]|~|\$|[a-z]:)/i.test(w) && !RECURSIVE.test(w) && !SAFE_SCRATCH.test(w));
}

function segments(text) {
  const out = [];
  let cur = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    const redirect = c === '&' && (text[i - 1] === '>' || text[i + 1] === '>');
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && !redirect)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every command hiding in the text: each piece of a chain, and the payload of sh -c, cmd /c, eval, ssh... */
function unfold(command, depth = 0) {
  const out = [];
  for (const seg of segments(command)) {
    const words = tokens(seg);
    out.push(words.map((w) => w.text));
    if (depth >= 3) continue;
    if (words.some((w) => !w.quoted && SHELL_TRIGGERS.has(w.text.toLowerCase()))) {
      for (const w of words) if (w.quoted && /\s/.test(w.text)) out.push(...unfold(w.text, depth + 1));
    }
  }
  return out;
}

const DENY = [
  { id: 'wipe-critical-path', test: removesCriticalPath, why: 'it deletes a home folder, a drive or a system folder' },
  { id: 'wipe-disk', re: /\b(?:mkfs(?:\.\w+)?|diskpart|format-volume)\b|\bdd\b.*\bof=\/dev\/|(?:^|\s)format\s+[a-z]:/i, why: 'it formats or overwrites a disk' },
];

const ASK = [
  { id: 'remove-outside-project', test: removesOutsideProject, why: 'it deletes folders outside this project' },
  { id: 'terraform-destroy', re: /\b(?:terraform|tofu|terragrunt)\b.*(?:\bdestroy\b|\bapply\b.*-destroy\b)/i, why: 'it destroys real infrastructure' },
  { id: 'cloud-delete', re: /\baws\b.*\b(?:terminate-instances|delete-[a-z-]+|s3\s+(?:rm|rb)|s3api\s+delete-[a-z-]+)\b|\b(?:gcloud|az|doctl|fly|flyctl)\b.*\b(?:delete|destroy)\b/i, why: 'it deletes cloud resources' },
  { id: 'cluster-delete', re: /\bkubectl\b.*\bdelete\b|\bhelm\b.*\b(?:uninstall|delete)\b/i, why: 'it deletes cluster resources' },
  { id: 'sql-destroy', re: /\b(?:drop\s+(?:database|table|schema)|truncate\s+table)\b|\bdelete\s+from\s+[\w."]+\s*;?\s*$/i, why: 'it drops or empties database tables' },
  { id: 'database-reset', re: /\bprisma\b.*(?:\bmigrate\s+reset\b|\bdb\s+push\b.*--(?:force-reset|accept-data-loss))|\bdrizzle-kit\b.*\bpush\b|(?:^|\s)(?:db:push|db:reset|db:drop|db:wipe|migrate:fresh|migrate:reset)\b|\bsupabase\b.*\bdb\s+reset\b|\b(?:dropdb|flushall|flushdb|dropDatabase)\b/i, why: 'it can reset or overwrite a database' },
  { id: 'git-discard', re: /\bgit\b.*\breset\b.*--hard\b|\bgit\b.*\b(?:checkout|restore)\b.*\s(?:--\s+)?\.(?:\s|$)|\bgit\b.*\bclean\b.*\s-[a-z]*f|\bgit\b.*\bstash\b.*\b(?:drop|clear)\b/i, why: 'it throws away uncommitted work' },
  { id: 'git-force-push', re: /\bgit\b.*\bpush\b.*(?:\s--force(?!-with-lease)\b|\s-[a-z]*f\b|\s\+\S)/i, why: 'it overwrites history on the remote' },
  { id: 'platform-delete', re: /\bvolumeDelete\b|\bmutation\b.*delete|\bcurl\b.*(?:-X\s*|--request\s+)DELETE\b|\brailway\b.*\b(?:delete|down)\b|\bheroku\b.*\bapps:destroy\b|\bgh\b.*\brepo\s+delete\b|\bvercel\b.*\b(?:remove|rm)\b/i, why: 'it deletes hosted data or services through an API' },
  { id: 'docker-volumes', re: /\bdocker\b.*\b(?:system\s+prune|volume\s+(?:rm|prune))\b|\bdocker\b.*\bcompose\b.*\bdown\b.*(?:\s-v\b|--volumes\b)/i, why: 'it deletes Docker volumes' },
  { id: 'bulk-move', re: /(?:^|\s)(?:mv|move|move-item)\s(?:.*\s)?\S*\*\S*\s+\S/i, why: 'it moves many files in one go, which can overwrite them' },
];

/** Decide about one command. Returns { decision: 'deny' | 'ask', id, why } or null. */
export function judge(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const all = unfold(command);
  const hit = (rules) => {
    for (const rule of rules) {
      for (const argv of all) {
        if (PRINTERS.has(program(argv[0] || '')) && !argv.some((w) => /\$\(|`/.test(w))) continue;
        if (rule.test ? rule.test(argv) : rule.re.test(argv.join(' '))) return rule;
      }
    }
    return null;
  };
  const deny = hit(DENY);
  if (deny) return { decision: 'deny', id: deny.id, why: deny.why };
  const ask = hit(ASK);
  return ask ? { decision: 'ask', id: ask.id, why: ask.why } : null;
}

/** What the hook answers in a given permission mode. No one is watching in bypass or dontAsk, so ask becomes deny. */
export function decide(command, mode) {
  const verdict = judge(command);
  if (!verdict) return null;
  const unattended = mode === 'bypassPermissions' || mode === 'dontAsk';
  return verdict.decision === 'ask' && unattended ? { ...verdict, decision: 'deny' } : verdict;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const verdict = decide(input?.tool_input?.command, input?.permission_mode);
  if (!verdict) return;
  const reason = verdict.decision === 'deny'
    ? `Blocked by crashtest guard: ${verdict.why}. Do not retry it in another form. If it is really needed, ask the user to run it themselves.`
    : `crashtest guard: ${verdict.why}. Confirm only if you are sure.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: reason },
  }));
}

// A broken guard must never break the session, so every failure ends quietly with exit 0.
if (basename(process.argv[1] || '') === 'crashtest-guard.mjs') main().catch(() => {});
