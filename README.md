# summon-agents

A zero-setup, editor-native orchestrator for parallel AI coding agents.

You plan and approve a change like normal; summon-agents decides whether the work
is worth splitting, runs isolated agents in parallel git worktrees, merges them
back locally (gated on a clean, validated merge), and opens a PR - no manual
worktree juggling, no tmux, no server to stand up.

## Status

Early development. See the implementation plan for scope and design.

Committed scope:

- **M1** - core + `summon-agents` CLI, Claude Code, local git worktrees, fires on
  plan approval (`ExitPlanMode` hook).
- **M2** - MCP server so the same core works from Claude Code, Cursor, and VS Code
  Copilot. Zero-install: `npx summon-agents-mcp` plus a one-time config snippet.

Deferred: cloud/remote execution for laptop-off durability.

## Development

```sh
pnpm install
pnpm build       # build all packages
pnpm typecheck   # tsc -b across the workspace
pnpm test        # vitest
```

Monorepo layout:

- `packages/core` (`@summon-agents/core`) - transport-free orchestration engine.
- `packages/cli` (`summon-agents`) - the CLI bin hooks invoke and you run by hand.
- `packages/mcp` (`summon-agents-mcp`) - stdio MCP server (M2).
