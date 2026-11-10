# crashtest

**Would your AI coding setup survive the incidents that already happened to other people?**

AI coding agents have deleted home folders, wiped drives, dropped production databases and destroyed cloud setups. Each of those stories is public. crashtest turns them into test cases and replays them against your own Claude Code permissions and hooks.

Nothing is executed. Each command is sent to your rules and hooks as a simulated tool call, and crashtest records the answer.

![The crash test report](docs/report-1440.png)

## Run it

```bash
git clone https://github.com/salman-moussa/crashtest
```

```bash
node crashtest/bin/crashtest.js --open
```

It needs Node 20 or newer and has no dependencies. Nothing leaves your machine.

You get a summary in the terminal and a report page, `crashtest-report.html`:

```
crashtest: 10 real incidents, 34 scenarios. Nothing was executed.

  Your mode (default)         34/34 stopped   0 blocked, 34 ask first, 0 run unasked
  YOLO mode                    9/34 stopped   0 blocked, 9 ask first, 25 run unasked
  YOLO mode + guard           34/34 stopped   34 blocked, 0 ask first, 0 run unasked
```

That is a fresh Claude Code install. In the normal mode it asks before every one of these commands. With `--dangerously-skip-permissions` (YOLO mode), 25 of the 34 run with no question.

## What it checks

Every scenario gets three verdicts:

| Column | Meaning |
|---|---|
| Your mode | What happens with your settings as they are |
| YOLO mode | What happens when permission prompts are skipped |
| With guard | YOLO mode again, with the crashtest guard hook added |

And each verdict is one of:

- **Blocked**: a deny rule or a hook stops it.
- **Asks you**: you get a prompt first. This only protects you if you read it.
- **Runs**: it runs with no question.

crashtest reads your user, project, local and managed settings, plus the hooks of your enabled plugins. It replays your real `PreToolUse` hooks, so a hook you wrote yourself is tested too.

It also tries each incident in other spellings. A rule that stops `rm -rf` often misses `/bin/rm -rf` or `bash -c 'rm -rf ...'`, and a rule for `git reset` misses `git -C . reset`.

One more thing it catches: a hook that refuses a command once and lets the retry through. An agent retries, so crashtest scores the second answer.

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
| Feb 2026 | Claude Code | terraform destroy takes out production and its backups |
| Apr 2026 | Cursor | One API call deletes a company database and its backups |

Every incident links to its public sources. Build the full page with all the stories:

```bash
node bin/crashtest.js museum
```

Each scenario is labelled:

- **As reported**: the command public reports quote.
- **Typical form**: the exact command was never published, so this is the usual form of that action.
- **Variant**: the same action written another way, to look for gaps.

## Close the gaps

```bash
node bin/crashtest.js fix
```

This installs one small hook, the crashtest guard, into your Claude Code settings. It backs up `settings.json` first and refuses to touch a settings file it cannot parse.

The guard reads each command before it runs:

- It **denies** deletes of a home folder, a drive or a system folder, and disk formatting.
- It **asks** before destroying infrastructure, deleting cloud resources, resetting databases, discarding git work, force pushing, deleting hosted volumes, and bulk moves.
- When nobody is watching (YOLO mode), every "ask" becomes a "deny".

It looks through wrappers such as `bash -c`, `cmd /c`, `ssh` and `sudo`. Remove it again with:

```bash
node bin/crashtest.js unfix
```

## Limits

- Verdicts follow the published Claude Code permission rules. crashtest is a model of that behaviour, not Claude Code itself. If the two disagree, Claude Code is right and that is a bug here.
- Claude Code only for now. Codex and Cursor are next.
- Sandboxing and auto mode are not modelled. Auto mode verdicts show as "Unknown".
- Only shell-command hooks are replayed. Prompt, agent, HTTP and MCP hooks are counted and skipped.
- The guard matches patterns. A command that hides its text (base64, or a script written to disk and then run) gets past it. Use it together with sandboxing, not instead of it.

## Add an incident

One incident is one JSON file in `incidents/`. It needs a date, the agent, a short summary in your own words, a lesson, at least two public sources, and the commands. Copy an existing file and open a pull request. The tests check the format and check that the guard stops every scenario:

```bash
npm test
```

## Licence

MIT
