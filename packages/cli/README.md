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

### Who does the work

Whoever you summon from runs their own vendor's agents.
`init` bakes the vendor into the MCP registration, so summoning from Claude Code dispatches **Claude** workers, from Cursor dispatches **Cursor** workers, and from Copilot dispatches **Copilot** workers - each on your own subscription for that tool.

**You must install the matching agent CLI before summoning** - summon-agents shells out to it, so it will not run without it. You'll also need **git** and **Node 20+**.

| Editor | Workers run on | Install the CLI (must be on your PATH) |
|---|---|---|
| Claude Code | Claude | [Claude Code](https://claude.com/claude-code) - provides `claude` |
| Cursor | Cursor | [Cursor CLI](https://cursor.com/cli) - provides `cursor-agent` |
| VS Code (Copilot) | Copilot | `npm install -g @github/copilot` (Node 22+) - provides `copilot` |

If the CLI is missing you'll get a clear `agent CLI "<x>" (vendor: <y>) not found on PATH` - that's the fix: install that vendor's CLI, then restart the MCP server.

The worker is a headless CLI, not the editor's chat pane (no editor exposes its in-chat agent to outside tools).
Override the binary with `SUMMON_AGENT_BIN`, or force a vendor with `SUMMON_AGENT_VENDOR` / `--vendor`.
Claude's CLI is the smoothest path; Cursor's is solid; Copilot's is newer, so treat it as experimental and verify its headless flags on your version.

## Use it

Plan your change in the editor like you always do. Then, instead of letting one agent grind through it:

**Just ask** (your agent calls the tool for you):
> Use summon_agents to add src/login.js, src/dashboard.js, and src/settings.js — three independent modules.

**Or use the shortcut** (installed per host):
> `/summon-agents`

It splits the work, runs the agents, merges the result, and tells you exactly how to run it.

**Host obedience differs.** Claude Code reliably delegates to the tool. Copilot (and to a lesser extent Cursor) will sometimes just implement the plan itself instead of calling `summon_agents`, and it won't infer "the plan" from earlier chat. If that happens, be explicit in one message: *"Call the `summon_agents` tool with this plan: <plan text>. Do NOT edit any files yourself."* Use the editor's **agent mode**, not its plan mode.

### Where the work ends up

- **No git remote?** It fast-forwards the branch you're on (your feature branch if you're on one, else `main`). Walk away, come back to finished work in place.
- **Have a remote?** It **pushes** the branch (plain `git push` — no `gh` needed, works with GitHub, GitLab, or Bitbucket) and your host offers to open a PR/MR. If `gh` happens to be installed, it opens the PR for you and hands back the link. Your local base stays clean, and the remote merge is never automatic.
- **Want to look before it lands?** Ask for review. It stages the merged, validated work on a branch and waits for your go-ahead before finalizing.

> The review checkpoint waits for your approval — confirmed in both **Claude Code** and **VS Code**. It relies on your editor's agent honoring the pause, so when you want a hard, unbypassable human sign-off, use a **remote**: a pushed branch / PR can only be merged by you, no matter what.

---

## What happens under the hood (and why it's safe to walk away)

1. **Triage** — an LLM decides split-or-single and carves the plan into tasks that touch *different* files.
2. **Dispatch** — one agent per task, each in its own `git worktree`, running **headless**. No mid-task prompts. That's the whole point — you leave.
3. **Watchdog** — a hard per-agent timeout plus a no-progress detector kill any agent that hangs or loops. A run can't stall forever waiting on nothing.
4. **Guardrails before anything merges** — did an agent touch files outside its lane? Does your repo's **own** check (`typecheck` / `build` / `test`) still pass? A clean git merge isn't enough; the code has to actually work.
5. **Merge & report** — good work lands on your branch (or is pushed to your remote for a PR/MR); broken work stops and tells you why.

And there's always a kill switch: `summon-agents abort <runId>` (or the `summon_abort` tool) stops a run and cleans up, anytime.

### Open the window (see what the agents are doing)

The agents run headless - the kitchen cooks with the door closed - but you can open the door anytime, from a terminal in the same repo:

```bash
npx -y summon-agents watch     # live dashboard, refreshes until the run finishes
npx -y summon-agents status    # one-shot snapshot
```

No run id needed - it defaults to the current run. Each agent shows its state, how long it's been running, how long it's been quiet, and **the files it has changed so far**, so a long build is legible instead of a black box. It's read-only - opening the window never disturbs the run. From your editor's chat you can ask for the same thing via the `summon_status` tool.

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
