---
description: Dispatch the approved plan to parallel summon-agents workers
allowed-tools: Bash, Write
---
The user wants to execute the current approved implementation plan using summon-agents - parallel, isolated agents - and NOT by implementing it yourself.

Do exactly this:
1. Call the `summon_agents` tool (provided by the summon-agents MCP server), passing the full text of the most recently approved plan as the `plan` argument. If no plan has been approved yet, stop and ask the user to plan first.
2. Do NOT implement the plan yourself, and do NOT edit project files. summon_agents creates an isolated git worktree per task, runs an agent in each, merges them back locally (gated on a clean, validated merge), and opens a PR (or reports a manual PR command if there is no remote).
3. Relay the tool's final report to the user verbatim.
