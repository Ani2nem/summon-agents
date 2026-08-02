# summon-agents

**Turn one approved plan into a team of AI agents that build it in parallel — from inside your editor's chat.**

You plan a change like normal. summon-agents decides whether the work is worth splitting, runs a separate coding agent for each independent piece in its own isolated git worktree, merges their work back (only if it's clean and passes your project's checks), and hands you the result. No terminal juggling, no tmux, no manual merges.

Works in **Claude Code**, **VS Code (Copilot)**, and **Cursor** through one small MCP server.

---

## The problem it solves

You ask an AI agent to build three things — say a login page, a dashboard, and a settings form. A single agent does them **one after another**, in **one context window**:

- It's **slow** — the work is serial even though the pieces are independent.
- It gets **sloppier** as it goes — a long, crowded context dilutes the model's attention, so the third feature gets less care than the first.
- A mistake mid-way can leave your working tree **half-broken**.

The manual fix is worse: hand-create a git worktree per task, open a stack of terminal tabs, start tmux, launch an agent in each, babysit the permission prompts, then merge it all together yourself.

**summon-agents automates that entire pipeline behind one step.**

## Why parallel beats one agent

| | Single agent | summon-agents |
|---|---|---|
| **Speed** | serial — total time = sum of all tasks | parallel — total time ≈ the *slowest* task |
| **Focus** | one bloated context; attention dilutes | each agent gets a clean, narrow context for *its* task → deeper, less sloppy work |
| **Safety** | a bad step dirties your working tree | each agent is sandboxed in its own worktree; a bad attempt is contained and thrown away |
| **Review** | changes interleaved in one blob | each task is an isolated, reviewable unit |

And it's not dumb about it: if the work is small or the pieces are coupled (they share files), the **brake** runs a single focused agent instead — because forcing a split on coupled work just creates merge conflicts.

---

## Install

One command sets up your editor:

```bash
npx -y summon-agents init          # in your project root (Claude Code)
npx -y summon-agents init --host cursor
npx -y summon-agents init --host copilot
```

That registers the MCP server and writes the trigger. Requirements: **git**, **Node 20+**, and a coding-agent CLI on your PATH (**[Claude Code](https://claude.com/claude-code)** by default; set `SUMMON_AGENT_BIN` for another).

## Use it

Plan your change in the editor as usual, then:

**Implicit** — just ask (the agent calls the tool for you):
> Use summon_agents to add src/login.js, src/dashboard.js, and src/settings.js — three independent modules.

**Explicit** — the trigger command (Claude Code):
> `/summon-agents`

It reports back what each agent built, merges the work, and tells you exactly how to run it.

### Where the work lands

- **No remote configured** → merged straight onto your local branch.
- **Remote + `gh` present** → opened as a **pull request** (it never merges the PR — that's your call).
- **Want a checkpoint?** Ask for review (`review: true`): it stages the merged, validated work on an integration branch and waits for your go-ahead before landing it.

> Note: the review checkpoint is honored reliably in Claude Code. Some hosts (e.g. Copilot) may self-approve — for a **guaranteed** human gate, use a remote so the PR is the gate.

---

## What it does under the hood (and why it's safe)

1. **Triage** — an LLM decides split-or-single and carves the plan into file-disjoint tasks.
2. **Dispatch** — one agent per task, each in its own `git worktree`, running **headless** (no mid-task prompts — you walk away).
3. **Watchdog** — a hard per-agent timeout + a no-progress detector reap any agent that hangs or loops, so a run never stalls forever.
4. **Guardrails before merge** — an out-of-lane check (did an agent touch files outside its task?) and your repo's **own validation command** (`typecheck`/`build`/`test`) must pass. A clean git merge isn't enough; the code has to actually work.
5. **Merge & report** — clean work lands (or becomes a PR); broken work stops for a human.

Kill switch: `summon-agents abort <runId>` (or the `summon_abort` tool) stops a run and cleans up anytime.

## CLI

The same engine is a plain CLI, for hooks or manual use:

```bash
summon-agents run --plan plan.md      # run a plan
summon-agents run --plan plan.md --review   # hold the merge for your approval
summon-agents merge <runId>           # finalize a held run
summon-agents gc                      # reap orphaned worktrees/branches
summon-agents abort <runId>           # stop and clean up a run
```

## License

MIT
