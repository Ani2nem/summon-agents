// server.ts - the summon-agents MCP server.
//
// Exposes the same core pipeline the CLI runs, as MCP tools the host model
// (Claude Code / Cursor / Copilot chat) can call. The host decides WHEN to
// summon; the server runs the full decompose -> dispatch -> merge -> PR pipeline
// with a headless agent CLI as the Judge and worker runner. One shared core,
// two skins.

import * as fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExecAgentRunner,
  GhVcs,
  agentAvailable,
  agentConfigFromEnv,
  claudeCommandBuilder,
  claudeJudge,
  finalizeRun,
  gc,
  loadRun,
  runPipeline,
  runsRoot,
  setRunStatus,
  type AgentResult,
  type Notifier,
  type PipelineResult,
  type RunState,
} from "@summon-agents/core";

const VERSION = "0.0.0";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function text(body: string, isError = false): TextResult {
  return { content: [{ type: "text", text: body }], isError };
}

/** A Notifier that collects progress lines for the tool response. */
function collectingNotifier(lines: string[]): Notifier {
  return {
    info: (m: string) => lines.push(`• ${m}`),
    agentDone: (r: AgentResult) =>
      lines.push(
        `  ${r.status === "success" ? "✓" : "✗"} ${r.slug}${
          r.summary ? `: ${r.summary}` : ""
        }`,
      ),
    runDone: (_s: RunState, summary: string) => lines.push(`done - ${summary}`),
  };
}

function formatResult(lines: string[], result: PipelineResult): string {
  const out = [...lines, "", `status: ${result.status}`, `reason: ${result.reason}`];
  if (result.mergedSlugs) out.push(`merged: ${result.mergedSlugs.join(", ") || "(none)"}`);
  if (result.landedOn) out.push(`work is on branch: ${result.landedOn}`);
  if (result.validationLabel) out.push(`validated: ${result.validationLabel}`);
  if (result.pr?.opened) out.push(`PR: ${result.pr.url}`);
  else if (result.pr?.manualCommand) out.push(`open a PR: ${result.pr.manualCommand}`);
  else if (result.pr?.reason) out.push(result.pr.reason);
  if (result.runCommand) out.push(`run it: ${result.runCommand}`);
  if (result.status === "awaitingReview") {
    out.push(
      `To finalize after reviewing, call summon_merge with runId "${result.runId}". To discard, call summon_abort.`,
    );
  }
  return out.join("\n");
}

/** Build the MCP server bound to a repo root (defaults to the process cwd). */
export function createServer(repoRoot: string = process.cwd()): McpServer {
  const server = new McpServer({ name: "summon-agents", version: VERSION });

  server.registerTool(
    "summon_agents",
    {
      title: "Summon parallel agents for an approved plan",
      description:
        "Execute an APPROVED implementation plan by dispatching it to parallel, isolated agents in git worktrees, then merging their work back (gated on a clean, validated merge) and opening a PR. Call this INSTEAD of implementing the plan yourself. Only call it once a plan has been approved. Set review=true to hold the merge for the user to approve first (then finalize with summon_merge).",
      inputSchema: {
        plan: z
          .string()
          .min(1)
          .describe("The full approved implementation plan to execute."),
        review: z
          .boolean()
          .optional()
          .describe(
            "If true, merge + validate but do NOT finalize - stop at a review gate and return awaitingReview. The user reviews the diff, then you call summon_merge to land it.",
          ),
      },
    },
    async ({ plan, review }) => {
      const cfg = agentConfigFromEnv();
      if (!(await agentAvailable(cfg))) {
        return text(
          `agent CLI "${cfg.bin}" not found on PATH. Install it or set SUMMON_AGENT_BIN.`,
          true,
        );
      }
      const lines: string[] = [];
      const result = await runPipeline(
        repoRoot,
        plan,
        {
          judge: claudeJudge(cfg),
          runner: new ExecAgentRunner(claudeCommandBuilder(cfg)),
          vcs: new GhVcs(),
          notifier: collectingNotifier(lines),
        },
        { review: Boolean(review) },
      );
      return text(formatResult(lines, result), result.status === "needsHuman");
    },
  );

  server.registerTool(
    "summon_merge",
    {
      title: "Finalize a summon-agents run held for review",
      description:
        "Finalize a run that was held by review=true: fast-forward the base branch onto the reviewed integration branch (no remote) or open a PR (remote present). Call this after the user has reviewed the diff and approved.",
      inputSchema: {
        runId: z.string().describe("The run id to finalize."),
      },
    },
    async ({ runId }) => {
      const lines: string[] = [];
      const result = await finalizeRun(repoRoot, runId, {
        vcs: new GhVcs(),
        notifier: collectingNotifier(lines),
      });
      return text(formatResult(lines, result), result.status === "needsHuman");
    },
  );

  server.registerTool(
    "summon_status",
    {
      title: "Status of summon-agents runs",
      description:
        "Report the status of a specific summon-agents run, or list recent runs if no id is given.",
      inputSchema: {
        runId: z.string().optional().describe("A run id, or omit to list runs."),
      },
    },
    async ({ runId }) => {
      if (runId) {
        const state = await loadRun(repoRoot, runId);
        return state
          ? text(`${state.runId}: ${state.status} (updated ${state.updatedAt})`)
          : text(`no such run: ${runId}`, true);
      }
      let ids: string[] = [];
      try {
        ids = await fs.readdir(runsRoot(repoRoot));
      } catch {
        return text("no runs yet");
      }
      const rows: string[] = [];
      for (const id of ids.sort().reverse().slice(0, 20)) {
        const s = await loadRun(repoRoot, id);
        if (s) rows.push(`${s.runId}: ${s.status}`);
      }
      return text(rows.length ? rows.join("\n") : "no runs yet");
    },
  );

  server.registerTool(
    "summon_gc",
    {
      title: "Reap orphaned summon-agents worktrees/branches",
      description:
        "Clean up orphaned worktrees and lane branches left by dead runs (integration branches are preserved).",
      inputSchema: {},
    },
    async () => {
      const reaped = await gc(repoRoot);
      return text(
        `reaped ${reaped.worktreesRemoved.length} worktree(s), ${reaped.branchesDeleted.length} branch(es)`,
      );
    },
  );

  server.registerTool(
    "summon_abort",
    {
      title: "Abort a summon-agents run",
      description:
        "Abort a run and clean up its worktrees and branches.",
      inputSchema: {
        runId: z.string().describe("The run id to abort."),
      },
    },
    async ({ runId }) => {
      const state = await loadRun(repoRoot, runId);
      if (!state) return text(`no such run: ${runId}`, true);
      await setRunStatus({ repoRoot, state, status: "aborted" });
      return text(`aborted ${runId}`);
    },
  );

  return server;
}
