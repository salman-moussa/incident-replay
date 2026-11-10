// Quote-aware shell reading, just enough to match Claude Code permission rules.
// ponytail: not a bash parser. No heredocs, and control-flow bodies are only unwrapped
// by keyword. Move to a real parser (tree-sitter-bash) if verdicts drift from Claude Code.

/** Split on && || ; | |& & and newlines, outside quotes and parentheses. */
export function splitCommand(command, { backslash = true } = {}) {
  const parts = [];
  let cur = '', quote = null, depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i], next = command[i + 1];
    if (quote) {
      cur += c;
      if (backslash && c === '\\' && quote === '"' && next !== undefined) { cur += next; i++; }
      else if (c === quote) quote = null;
      continue;
    }
    if (backslash && c === '\\' && next !== undefined) { cur += c + next; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); cur += c; continue; }
    if (depth === 0) {
      if (c === '\n' || c === ';') { parts.push(cur); cur = ''; continue; }
      const redirect = c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || next === '>');
      if ((c === '&' || c === '|') && !redirect) {
        parts.push(cur); cur = '';
        if (next === c || (c === '|' && next === '&')) i++;
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** The commands inside $( ), <( ), >( ) and backticks. Single-quoted text is skipped. */
export function substitutions(text) {
  const out = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === "'" && quote !== '"') { quote = "'"; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { out.push(text.slice(i + 1, end)); i = end; }
      continue;
    }
    if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') {
      let depth = 1, j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    }
  }
  return out;
}

const KEYWORD = /^(?:do|then|else|elif|if|while|until|\{)\s+/;

/** Every command in the text: each piece of a chain, plus subshells, substitutions and loop bodies. */
export function allSubcommands(command, options) {
  const out = [];
  for (let sub of splitCommand(command, options)) {
    while (KEYWORD.test(sub)) sub = sub.replace(KEYWORD, '');
    if (!sub || /^(?:done|fi|\}|esac)$/.test(sub)) continue;
    if (sub.startsWith('(') && sub.endsWith(')')) { out.push(...allSubcommands(sub.slice(1, -1), options)); continue; }
    out.push(sub);
    for (const inner of substitutions(sub)) out.push(...allSubcommands(inner, options));
  }
  return out;
}

// ponytail: Claude Code says it strips "certain known-safe" variables and does not publish
// the list. These are the documented examples plus obvious display ones.
const SAFE_ENV = new Set(['NODE_ENV', 'LANG', 'LC_ALL', 'NO_COLOR', 'FORCE_COLOR', 'TZ', 'CI', 'TERM']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|\S*)\s+/;
const WRAPPERS = [
  /^timeout\s+(?:(?:-k|-s|--kill-after|--signal)(?:=|\s+)\S+\s+|-\S+\s+)*\S+\s+/,
  /^time\s+(?:-p\s+)?/,
  /^nice\s+(?:-n\s+-?\d+\s+|-\d+\s+|--adjustment=-?\d+\s+)?/,
  /^nohup\s+/,
  /^stdbuf\s+(?:-\S+\s+)+/,
  /^command\s+(?![-]v\b|-V\b)(?:-p\s+)?/,
  /^(?:builtin|noglob)\s+/,
  /^xargs\s+(?!-)/,
];

/**
 * Drop what Claude Code drops before matching: leading VAR=value and wrappers like timeout.
 * `unsafeEnv` is true when a variable outside the safe list was assigned, which stops allow rules.
 */
export function stripWrappers(sub) {
  let text = sub.trim(), unsafeEnv = false;
  for (let changed = true; changed;) {
    changed = false;
    const m = ASSIGNMENT.exec(text);
    if (m) {
      if (!SAFE_ENV.has(m[1])) unsafeEnv = true;
      text = text.slice(m[0].length); changed = true;
      continue;
    }
    for (const re of WRAPPERS) {
      if (re.test(text)) { text = text.replace(re, ''); changed = true; break; }
    }
  }
  return { text, unsafeEnv };
}
