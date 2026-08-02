# summon-agents

**Approve a plan, walk away, come back to finished work. Your coffee's still warm.**

summon-agents turns one approved plan into a team of AI coding agents that build it in parallel — each in its own isolated git worktree — then merges their work back and hands you the result, right from your editor's chat.

Works in **Claude Code**, **VS Code (Copilot)**, and **Cursor**.

---

## The problem

You ask your AI agent to build three things — a login page, a dashboard, a settings form. It builds them one at a time, in one long conversation. Slow, and it gets a little sloppier with each feature as the context fills up.

So you try to parallelize it yourself. You create a git worktree for each task. You open three terminal tabs. You start tmux. You launch an agent in each, paste in instructions, and go grab a coffee while they work.

You come back. One agent stopped to ask permission twenty minutes ago and has just been... sitting there. Another wandered into the wrong files. The third finished, but now you get to merge all three by hand. You're sweating, hunched over three terminals trying to figure out what happened, and your coffee is stone cold. You spent the whole time babysitting instead of thinking.

**That's the tax on doing this yourself.** summon-agents pays it for you: **no terminal juggling, no tmux, no manual merges.** You approve a plan, walk away, and come back to finished, merged, validated work.

## Why a team beats one agent

It's not just faster — it's better work:

| | One agent | summon-agents |
|---|---|---|
| **Speed** | serial: total time = every task added up | parallel: total time ≈ the *slowest* task |
| **Focus** | one bloated context, attention spread thin | each agent gets a clean, narrow context for *its* task — so it goes deeper and stays sharp |
| **Safety** | a wrong turn dirties your working tree | each agent is sandboxed in its own worktree; a bad attempt is contained and thrown away |
| **Review** | everything tangled in one blob | each task is a clean, separate unit you can actually read |

And it's not reckless about it. If the work is small, or the pieces are tangled together (they touch the same files), the **brake** just runs one focused agent — because forcing a split on coupled work only creates merge conflicts. It splits when splitting helps, and doesn't when it doesn't.

---

## Install

One command sets up your editor:

```bash
npx -y summon-agents init                 # Claude Code
npx -y summon-agents init --host cursor    # Cursor
npx -y summon-agents init --host copilot   # VS Code (Copilot)
```

You'll need **git**, **Node 20+**, and a coding-agent CLI on your PATH — **[Claude Code](https://claude.com/claude-code)** by default (set `SUMMON_AGENT_BIN` to use another).

## Use it

Plan your change in the editor like you always do. Then, instead of letting one agent grind through it:

**Just ask** (your agent calls the tool for you):
> Use summon_agents to add src/login.js, src/dashboard.js, and src/settings.js — three independent modules.

**Or use the shortcut** (Claude Code):
> `/summon-agents`

It splits the work, runs the agents, merges the result, and tells you exactly how to run it.

### Where the work ends up

- **No git remote?** It merges straight onto your local branch. Done.
- **Have a remote (+ `gh`)?** It opens a **pull request** — and never merges it. That's your call.
- **Want to look before it lands?** Ask for review. It stages the merged, validated work on a branch and waits for your go-ahead before finalizing.

> The review checkpoint held for your approval in both Claude Code and VS Code in testing. Since it relies on your editor's agent honoring the pause, use a **remote** when you want a hard, unbypassable human sign-off — a PR can only be merged by you.

---

## What happens under the hood (and why it's safe to walk away)

1. **Triage** — an LLM decides split-or-single and carves the plan into tasks that touch *different* files.
2. **Dispatch** — one agent per task, each in its own `git worktree`, running **headless**. No mid-task prompts. That's the whole point — you leave.
3. **Watchdog** — a hard per-agent timeout plus a no-progress detector kill any agent that hangs or loops. A run can't stall forever waiting on nothing.
4. **Guardrails before anything merges** — did an agent touch files outside its lane? Does your repo's **own** check (`typecheck` / `build` / `test`) still pass? A clean git merge isn't enough; the code has to actually work.
5. **Merge & report** — good work lands (or becomes a PR); broken work stops and tells you why.

And there's always a kill switch: `summon-agents abort <runId>` (or the `summon_abort` tool) stops a run and cleans up, anytime.

## Also a plain CLI

The same engine runs from the terminal — for hooks, scripts, or by hand:

```bash
summon-agents run --plan plan.md            # run a plan
summon-agents run --plan plan.md --review   # hold the merge for your approval
summon-agents merge <runId>                 # finalize a held run
summon-agents gc                            # reap orphaned worktrees/branches
summon-agents abort <runId>                 # stop and clean up a run
```

## License

MIT
