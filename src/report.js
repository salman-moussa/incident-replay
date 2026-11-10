// Turns a crash test result into terminal text and a self-contained HTML page.
// The same page, without verdicts, is the incident museum.

const LABEL = { blocked: 'Blocked', asks: 'Asks you', runs: 'Runs', unknown: 'Unknown' };
const WORDS = { blocked: 'blocked', asks: 'ask you first', runs: 'run unasked', unknown: 'unknown' };
const KIND = { reported: 'As reported', representative: 'Typical form', variant: 'Variant' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (bucket, key) => bucket[key] || 0;
export const stopped = (bucket) => n(bucket, 'blocked') + n(bucket, 'asks');
const names = (agents) => agents.map((a) => a.name).join(', ').replace(/, ([^,]*)$/, ' and $1');

function day(date) {
  const [y, m, d] = date.split('-');
  return [d && String(Number(d)), MONTHS[Number(m) - 1], y].filter(Boolean).join(' ');
}

/** Plain-text summary for the terminal. `paint` adds colour when the output is a terminal. */
export function terminalSummary(report, paint = (text) => text) {
  const line = (name, b) => `  ${name.padEnd(42)} ${String(stopped(b)).padStart(3)}/${report.scenarios} stopped   `
    + `${n(b, 'blocked')} blocked, ${n(b, 'asks')} ask first, ${paint(`${n(b, 'runs')} run unasked`, n(b, 'runs') ? 'bad' : 'ok')}`
    + (n(b, 'unknown') ? `, ${n(b, 'unknown')} unknown` : '');
  const out = ['', `crashtest: ${report.incidents.length} real incidents, ${report.scenarios} scenarios. Nothing was executed.`];
  for (const agent of report.agents) {
    out.push('', agent.name, line(`Your mode (${agent.mode})`, agent.totals.normal));
    out.push(agent.yoloDisabled ? '  YOLO mode                                  disabled in your settings' : line(`YOLO mode (${agent.yoloName})`, agent.totals.yolo));
    if (agent.hasGuard) out.push(line('YOLO mode + crashtest guard', agent.totals.guarded));
    for (const note of agent.notes) out.push(`  note: ${note}`);
  }
  const gap = report.agents.find((a) => a.hasGuard && n(a.totals.guarded, 'runs') < n(a.totals.yolo, 'runs'));
  if (gap) out.push('', `Close the ${gap.name} gap:  crashtest fix`);
  return out.join('\n');
}

const CSS = `
:root{--bg:#f6f5f1;--surface:#fff;--ink:#16181d;--muted:#5c6370;--line:#e2e0d9;--accent:#b4440f;--ok:#1f7a4d;--warn:#8f5f00;--bad:#b42318;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--ink:#e8e9ec;--muted:#9aa1ad;--line:#272b34;--accent:#f0803c;--ok:#4cc38a;--warn:#e2b340;--bad:#f97066;--code:#1e222b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
a{color:inherit;text-underline-offset:3px}
a:hover{color:var(--accent)}
code,.mono{font-family:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace}
.wrap{max-width:1080px;margin:0 auto;padding:48px 24px 80px}
.mark{font-weight:600;font-size:14px;color:var(--accent);margin:0}
h1{font-size:clamp(28px,4.6vw,44px);line-height:1.12;letter-spacing:-.02em;margin:16px 0 12px;max-width:26ch;text-wrap:balance}
.lead{color:var(--muted);max-width:64ch;margin:0 0 40px;font-size:17px}
h2.section{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
.agent{margin:0 0 40px}
.agent>h2{font-size:22px;letter-spacing:-.01em;margin:0 0 14px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:0 0 14px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}
.tile h3{font-size:14px;font-weight:600;margin:0;color:var(--muted)}
.tile h3 span{font-weight:400;overflow-wrap:anywhere}
.score{margin:10px 0 14px;font-variant-numeric:tabular-nums}
.score strong{font-size:44px;line-height:1;letter-spacing:-.03em}
.score span{color:var(--muted);margin-left:6px}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line);gap:2px}
.bar i{display:block;min-width:0}
.bar .blocked{background:var(--ok)}.bar .asks{background:var(--warn)}.bar .runs{background:var(--bad)}.bar .unknown{background:var(--muted)}
.legend{list-style:none;padding:0;margin:12px 0 0;font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 14px}
.legend li::before,.chip::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:currentColor}
.legend .blocked,.chip.blocked{color:var(--ok)}.legend .asks,.chip.asks{color:var(--warn)}.legend .runs,.chip.runs{color:var(--bad)}.legend .unknown,.chip.unknown{color:var(--muted)}
.legend li span,.chip span{color:var(--ink)}
.note{color:var(--muted);font-size:14px;margin:0 0 14px;max-width:80ch}
.gap{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:8px;padding:14px 20px}
.gap summary{cursor:pointer;font-size:15px;font-weight:600}
.gap p{margin:8px 0 0;color:var(--muted);font-size:14px}
.gap ul{margin:8px 0 0;padding:0;list-style:none}
.gap li{padding:6px 0;border-top:1px solid var(--line);font-size:14px;overflow-wrap:anywhere}
.fix{display:inline-block;margin-top:10px;background:var(--code);border-radius:6px;padding:6px 10px;font-size:14px}
.incident{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;margin:0 0 16px}
.meta{font-size:13px;color:var(--muted);margin:0}
.incident h3{font-size:21px;line-height:1.25;letter-spacing:-.01em;margin:6px 0 10px;text-wrap:balance}
.incident p{margin:0 0 10px;max-width:74ch}
.lesson{border-left:3px solid var(--accent);padding-left:12px}
.sources{font-size:14px;color:var(--muted);margin:0 0 4px;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:2px 16px}
.rows{margin-top:16px;border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:minmax(0,1fr) repeat(var(--agents,1),176px);gap:16px;padding:14px 0;border-bottom:1px solid var(--line);align-items:start}
.row:last-child{border-bottom:0;padding-bottom:0}
.plain .row{grid-template-columns:1fr}
.head{font-size:12px;color:var(--muted);padding:10px 0}
.cmd{display:block;background:var(--code);border-radius:6px;padding:8px 10px;font-size:13px;overflow-wrap:anywhere;white-space:pre-wrap}
.kind{font-size:13px;color:var(--muted);margin:6px 0 0}
.cell>b{display:none;font-size:13px;margin-bottom:4px}
.v{display:grid;grid-template-columns:44px 1fr;font-size:12px;color:var(--muted);align-items:baseline;margin:0 0 6px}
.chip{font-size:14px;font-weight:600;white-space:nowrap}
.why{grid-column:2;font-size:12px;color:var(--muted);margin:1px 0 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
footer{margin-top:44px;color:var(--muted);font-size:14px;max-width:76ch}
footer p{margin:0 0 8px}
@media(max-width:900px){.tiles{grid-template-columns:1fr}.row{grid-template-columns:1fr;gap:10px}.head{display:none}.cell>b{display:block}}
@media(max-width:600px){.wrap{padding:28px 16px 56px}.incident{padding:18px}.score strong{font-size:38px}}
`;

function page({ title, mark, heading, lead, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<p class="mark mono">${esc(mark)}</p>
<h1>${esc(heading)}</h1>
<p class="lead">${lead}</p>
${body}
</div>
</body>
</html>
`;
}

function tile(name, detail, bucket, total) {
  const parts = ['blocked', 'asks', 'runs', 'unknown'].filter((k) => n(bucket, k));
  const legend = ['blocked', 'asks', 'runs', ...(n(bucket, 'unknown') ? ['unknown'] : [])];
  return `<section class="tile">
<h3>${esc(name)} <span>· ${esc(detail)}</span></h3>
<p class="score"><strong>${stopped(bucket)}</strong><span>of ${total} stopped</span></p>
<div class="bar" role="img" aria-label="${esc(parts.map((k) => `${n(bucket, k)} ${WORDS[k]}`).join(', '))}">${parts.map((k) => `<i class="${k}" style="flex:${n(bucket, k)}"></i>`).join('')}</div>
<ul class="legend">${legend.map((k) => `<li class="${k}"><span>${n(bucket, k)} ${WORDS[k]}</span></li>`).join('')}</ul>
</section>`;
}

function agentBlock(agent, report) {
  const unasked = report.incidents.flatMap((i) => i.scenarios.filter((s) => s.verdicts[agent.id].yolo.verdict === 'runs').map((s) => ({ s, i })));
  const yolo = agent.yoloDisabled
    ? '<section class="tile"><h3>YOLO mode <span>· disabled in your settings</span></h3><p class="score"><span>It cannot be switched on.</span></p></section>'
    : tile('YOLO mode', agent.yoloName, agent.totals.yolo, report.scenarios);
  const gap = unasked.length && !agent.yoloDisabled ? `<details class="gap">
<summary>${unasked.length} of ${report.scenarios} would run with no question in YOLO mode</summary>
<p>YOLO mode is <code>${esc(agent.yoloName)}</code>. With it, only hard rules and hooks stand between the agent and these commands.</p>
<ul>${unasked.map(({ s, i }) => `<li><code>${esc(s.command)}</code> · <a href="#${esc(i.id)}">${esc(i.title)}</a></li>`).join('')}</ul>
${agent.hasGuard && n(agent.totals.guarded, 'runs') < n(agent.totals.yolo, 'runs') ? '<code class="fix">crashtest fix</code>' : ''}
</details>` : '';
  return `<section class="agent">
<h2>${esc(agent.name)}</h2>
<div class="tiles">
${tile('Your mode', agent.mode, agent.totals.normal, report.scenarios)}
${yolo}
${agent.hasGuard ? tile('YOLO mode', 'with the crashtest guard', agent.totals.guarded, report.scenarios) : ''}
</div>
<p class="note">${agent.notes.map(esc).join(' ')}</p>
${gap}
</section>`;
}

const verdictLine = (label, v) => `<p class="v"><span>${label}</span><span class="chip ${v.verdict}"><span>${LABEL[v.verdict]}</span></span><span class="why" title="${esc(v.by)}">${esc(v.by)}</span></p>`;

function cell(agent, verdicts) {
  return `<div class="cell"><b>${esc(agent.name)}</b>${verdictLine('yours', verdicts.normal)}${verdictLine('YOLO', verdicts.yolo)}${verdicts.guarded ? verdictLine('guard', verdicts.guarded) : ''}</div>`;
}

function incidentCard(incident, agents) {
  const rows = incident.scenarios.map((s) => `<div class="row">
<div><code class="cmd">${esc(s.command)}</code><p class="kind">${KIND[s.kind]}${s.tool ? ` · ${esc(s.tool)}` : ''}. ${esc(s.note)}</p></div>
${agents.map((a) => cell(a, s.verdicts[a.id])).join('')}
</div>`).join('\n');
  const head = agents.length ? `<div class="row head"><div>Command</div>${agents.map((a) => `<div>${esc(a.name)}</div>`).join('')}</div>` : '';
  return `<article class="incident" id="${esc(incident.id)}">
<p class="meta">${esc(day(incident.date))} · ${esc(incident.agent)}</p>
<h3>${esc(incident.title)}</h3>
<p>${esc(incident.summary)}</p>
<p class="lesson">${esc(incident.lesson)}</p>
<ul class="sources">${incident.sources.map((s) => `<li><a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ul>
<div class="rows${agents.length ? '' : ' plain'}" style="--agents:${agents.length || 1}">${head}${rows}</div>
</article>`;
}

const KINDS_NOTE = '<p>"As reported" is the command public reports quote. "Typical form" is used when the exact command was never published. "Variant" is the same action written another way, to test for gaps.</p>';

export function htmlReport(report) {
  const body = `${report.agents.map((a) => agentBlock(a, report)).join('\n')}
<h2 class="section">The incidents</h2>
${report.incidents.map((i) => incidentCard(i, report.agents)).join('\n')}
<footer>
<p>crashtest replays each command as a simulated tool call against permission rules and hooks. No command is executed, and nothing leaves your machine.</p>
${KINDS_NOTE}
<p>Each row shows three answers per agent: "yours" is your setup as it is, "YOLO" is the skip-everything mode, and "guard" is YOLO mode with the crashtest guard added.</p>
<p>Verdicts follow each tool's published permission rules. They are a model of that behaviour, not the tool itself.</p>
</footer>`;
  return page({
    title: 'Crash test report',
    mark: `crashtest · ${day(report.generatedAt.slice(0, 10))}`,
    heading: 'Would your AI coding setup survive these real incidents?',
    lead: `${report.scenarios} commands from ${report.incidents.length} public incidents were replayed against your ${esc(names(report.agents))} setup. Nothing was executed.`,
    body,
  });
}

export function htmlMuseum(incidents) {
  const newestFirst = [...incidents].sort((a, b) => b.date.localeCompare(a.date));
  const body = `<h2 class="section">${incidents.length} incidents, newest first</h2>
${newestFirst.map((i) => incidentCard(i, [])).join('\n')}
<footer>
<p>Every entry links to public sources. Test your own setup against all of them with <a href="https://github.com/salman-moussa/crashtest">crashtest</a>.</p>
${KINDS_NOTE}
</footer>`;
  return page({
    title: 'AI agent incidents',
    mark: 'crashtest · incident museum',
    heading: 'Real incidents where an AI coding agent destroyed real work',
    lead: 'What happened, the command behind it, and the lesson. Each one is a test case you can replay against your own setup, safely.',
    body,
  });
}
