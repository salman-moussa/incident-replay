# incident-replay

**Would your AI coding setup survive the incidents that already happened to other people?**

AI coding agents have deleted home folders, wiped drives, dropped production databases and destroyed cloud setups. Each of those stories is public. incident-replay turns them into test cases and replays them against your own Claude Code, Codex and Cursor setup.

Nothing is executed. Each command is sent to your rules and hooks as a simulated tool call, and incident-replay records the answer.

![The incident replay report](docs/report-1440.png)

## Run it

```bash
npx incident-replay --open
```

It needs Node 20 or newer and has no dependencies. Nothing leaves your machine.

It tests every agent it finds on your machine. You get a summary in the terminal and a report page, `incident-replay-report.html`:

```
incident-replay: 14 real incidents, 44 scenarios. Nothing was executed.

Claude Code
  Your mode (default)                         44/44 stopped   0 blocked, 44 ask first, 0 run unasked
  YOLO mode (--dangerously-skip-permissions)  10/44 stopped   0 blocked, 10 ask first, 34 run unasked
  YOLO mode + incident-replay guard                 44/44 stopped   44 blocked, 0 ask first, 0 run unasked

Codex
  Your mode (read-only, on-request)           44/44 stopped   0 blocked, 44 ask first, 0 run unasked
  YOLO mode (--yolo)                           0/44 stopped   0 blocked, 0 ask first, 44 run unasked

Cursor
  Your mode (ask unless allowed)              44/44 stopped   0 blocked, 44 ask first, 0 run unasked
  YOLO mode (--force)                          0/44 stopped   0 blocked, 0 ask first, 44 run unasked
```

Those are fresh installs. In the normal mode each tool asks before every one of these commands. In the skip-everything mode, almost nothing stops them. Your own numbers depend on your rules, your hooks and the mode you really use.

## What it checks

Every scenario gets a verdict for your setup as it is, and one for YOLO mode, the mode that skips prompts:

- **Blocked**: a rule, a hook or a sandbox stops it.
- **Asks you**: you get a prompt first. This only protects you if you read it.
- **Runs**: it runs with no question.

| Agent | What incident-replay reads | YOLO mode |
|---|---|---|
| Claude Code | User, project, local and managed settings. Permission rules. `PreToolUse` hooks, including plugin hooks, replayed for real. | `--dangerously-skip-permissions` |
| Codex | `config.toml` (approval policy, sandbox mode, network access, project trust) and the rules files. | `--yolo` |
| Cursor | CLI permissions (`cli-config.json`, `.cursor/cli.json`) and `beforeShellExecution` hooks, replayed for real. | `--force` |

Pick agents by hand with `--agents claude,codex,cursor`.

It also tries each incident in other spellings. A rule that stops `rm -rf` often misses `/bin/rm -rf` or `bash -c 'rm -rf ...'`, and a rule for `git push` misses `git -c ... push`.

One more thing it catches: a hook that refuses a command once and lets the retry through. An agent retries, so incident-replay scores the second answer.

## The incidents

| When | Agent | What happened |
|---|---|---|
| Jun 2025 | Cursor | Auto-run mode deletes far more than the project |
| Jul 2025 | Replit Agent | Production database deleted during a code freeze |
| Jul 2025 | Amazon Q Developer | A wiper prompt shipped inside an official extension |
| Jul 2025 | Gemini CLI | Files lost while moving them to a folder that did not exist |
| Nov 2025 | Google Antigravity | A cache cleanup wipes an entire drive |
| Dec 2025 | Amazon Kiro | An agent decides to delete and recreate a live environment |
| Dec 2025 | Claude Code | A repository cleanup deletes the home directory |
| Jan 2026 | Claude Code | Uncommitted work thrown away by a git command |
| Feb 2026 | Claude Cowork | Tidying a desktop deletes fifteen years of family photos |
| Feb 2026 | Claude Code | terraform destroy takes out production and its backups |
| Apr 2026 | Cursor | One API call deletes a company database and its backups |
| Jul 2026 | Claude Opus 5 agent | A schema check drops every table in production |
| Aug 2026 | Claude Code, Cursor | A rejected push is retried with force |
| Sep 2026 | Codex | Recursive deletes reach the home folder and the drive root |

Every incident links to its public sources. Read all the stories in the [incident museum](https://salman-moussa.github.io/incident-replay/), or build that page yourself:

```bash
npx incident-replay museum
```

Each scenario is labelled:

- **As reported**: the command public reports quote.
- **Typical form**: the exact command was never published, so this is the usual form of that action.
- **Variant**: the same action written another way, to look for gaps.

## Close the gaps

```bash
npx incident-replay fix
```

This installs one small hook, the incident-replay guard, into your Claude Code settings. It backs up `settings.json` first and refuses to touch a settings file it cannot parse.

The guard reads each command before it runs:

- It **denies** deletes of a home folder, a drive or a system folder, and disk formatting.
- It **asks** before destroying infrastructure, deleting cloud resources, resetting databases, discarding git work, force pushing, deleting hosted volumes, and bulk moves.
- When nobody is watching (YOLO mode), every "ask" becomes a "deny".

It looks through wrappers such as `bash -c`, `cmd /c`, `ssh` and `sudo`. Remove it again with:

```bash
npx incident-replay unfix
```

The guard is for Claude Code only for now. For Codex and Cursor, incident-replay tests your setup but does not change it.

## Limits

- Verdicts follow each tool's published permission rules. incident-replay is a model of that behaviour, not the tool itself. If the two disagree, the tool is right and that is a bug here.
- Codex protects with a sandbox, so its verdicts come from what each command touches: files outside the workspace, the `.git` folder, or the network. The sandbox itself is not run. The Codex docs do not say whether rules still apply with `--yolo`, so that case shows as "Unknown".
- Cursor: the CLI permissions and hooks are read. The auto-run list inside the Cursor app is not.
- Claude Code: sandboxing and auto mode are not modelled. Auto mode verdicts show as "Unknown".
- Only shell-command hooks are replayed. Prompt, agent, HTTP and MCP hooks are counted and skipped.
- The guard matches patterns. A command that hides its text (base64, or a script written to disk and then run) gets past it. Use it together with sandboxing, not instead of it.

## Add an incident

One incident is one JSON file in `incidents/`. It needs a date, the agent, a short summary in your own words, a lesson, at least two public sources, and the commands. Each command also says what it touches (`outside`, `workspace`, `git` or `network`). Copy an existing file and open a pull request. The tests check the format and check that the guard stops every scenario:

```bash
npm test
```

## Licence

MIT
