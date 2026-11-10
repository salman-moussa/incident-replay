// Runs the crash test for every agent found on this machine and merges the results.

import { existsSync } from 'node:fs';
import { claudeAgent, configDir } from './claude.js';
import { codexAgent, codexDir } from './codex.js';
import { cursorAgent, cursorDir } from './cursor.js';

export const AGENTS = {
  claude: { run: claudeAgent, dir: configDir },
  codex: { run: codexAgent, dir: codexDir },
  cursor: { run: cursorAgent, dir: cursorDir },
};

/** The agents with a config folder on this machine. Claude Code is the fallback. */
export function detectAgents(env = process.env) {
  const found = Object.keys(AGENTS).filter((id) => existsSync(AGENTS[id].dir(env)));
  return found.length ? found : ['claude'];
}

/**
 * Replay every scenario against each agent. Each agent gives a verdict for its normal mode
 * and for its skip-everything mode. Nothing is executed.
 */
export async function crashTest({ cwd = process.cwd(), env = process.env, incidents, agents, useHooks = true, onProgress = () => {} }) {
  const ids = agents?.length ? agents : detectAgents(env);
  const unknown = ids.find((id) => !AGENTS[id]);
  if (unknown) throw new Error(`Unknown agent "${unknown}". Use one of: ${Object.keys(AGENTS).join(', ')}.`);

  const results = [];
  for (const id of ids) results.push(await AGENTS[id].run({ cwd, env, incidents, useHooks, onProgress }));

  const report = {
    generatedAt: new Date().toISOString(),
    scenarios: incidents.reduce((sum, i) => sum + i.scenarios.length, 0),
    agents: results.map(({ verdicts, ...agent }) => ({ ...agent, totals: { normal: {}, yolo: {}, guarded: {} } })),
    incidents: [],
  };
  for (const incident of incidents) {
    const scenarios = incident.scenarios.map((scenario) => {
      const verdicts = {};
      results.forEach((result, n) => {
        verdicts[result.id] = result.verdicts.get(scenario);
        for (const [key, value] of Object.entries(verdicts[result.id])) {
          const bucket = report.agents[n].totals[key];
          bucket[value.verdict] = (bucket[value.verdict] || 0) + 1;
        }
      });
      return { ...scenario, verdicts };
    });
    report.incidents.push({ ...incident, scenarios });
  }
  return report;
}
