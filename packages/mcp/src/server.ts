// server.ts - the summon-agents MCP server.
//
// Exposes the same core pipeline the CLI runs, as MCP tools the host model
// (Claude Code / Cursor / Copilot chat) can call. The host decides WHEN to
// summon; the server runs the full decompose -> dispatch -> merge -> PR pipeline
// with a headless agent CLI as the Judge and worker runner. One shared core,
// two skins.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExecAgentRunner,
  GhVcs,
  agentAvailable,
  agentConfigFromEnv,
  agentCommandBuilder,
  agentJudge,
  collectProgress,
  finalizeRun,
  formatProgress,
  formatProgressLine,
  gc,
  loadRun,
  runPipeline,
  setRunStatus,
  type AgentResult,
  type Notifier,
  type PipelineResult,
  type RunState,
} from "@summon-agents/core";

const VERSION = "0.4.2";

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
      `HUMAN REVIEW REQUIRED - do NOT finalize this yourself. Present the diff above to the user and WAIT for the user to explicitly say to merge. Only after the user approves, call summon_merge with runId "${result.runId}". If the user wants to discard, call summon_abort. Do not call summon_merge based on your own judgment.`,
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
            "If true, merge + validate but do NOT finalize - stop at a HUMAN review gate and return awaitingReview. You must then present the diff to the user and wait for the USER's explicit approval before calling summon_merge. Do not self-approve. Set this when the user asks to review before merging.",
          ),
      },
    },
    async ({ plan, review }, extra) => {
      const cfg = agentConfigFromEnv();
      if (!(await agentAvailable(cfg))) {
        return text(
          `agent CLI "${cfg.bin}" (vendor: ${cfg.vendor}) not found on PATH. ` +
            `Install that vendor's CLI, or set SUMMON_AGENT_BIN to a different binary.`,
          true,
        );
      }

      // Stream live progress back into the caller's chat via MCP progress
      // notifications - the split, each agent's completion, and a periodic
      // heartbeat with live file counts. Only fires if the client asked for
      // progress (sent a progressToken); otherwise it degrades to the final
      // report. Whether the editor renders it live is host-dependent.
      const progressToken = extra?._meta?.progressToken;
      let seq = 0;
      const emit = async (message: string): Promise<void> => {
        if (progressToken === undefined) return;
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: ++seq, message },
          });
        } catch {
          /* client may not support progress; ignore */
        }
      };

      const lines: string[] = [];
      const notifier: Notifier = {
        info: (m: string) => {
          lines.push(`• ${m}`);
          void emit(m);
        },
        agentDone: (r: AgentResult) => {
          const mark = r.status === "success" ? "✓" : "✗";
          lines.push(`  ${mark} ${r.slug}${r.summary ? `: ${r.summary}` : ""}`);
          void emit(`${mark} ${r.slug}`);
        },
        runDone: (_s: RunState, summary: string) => {
          lines.push(`done - ${summary}`);
          void emit(`done - ${summary}`);
        },
      };

      const result = await runPipeline(
        repoRoot,
        plan,
        {
          judge: agentJudge(cfg),
          runner: new ExecAgentRunner(agentCommandBuilder(cfg)),
          vcs: new GhVcs(),
          notifier,
        },
        {
          review: Boolean(review),
          onTick: async () => {
            const p = await collectProgress(repoRoot);
            if (p) await emit(formatProgressLine(p));
          },
        },
      );
      return text(formatResult(lines, result), result.status === "needsHuman");
    },
  );

  server.registerTool(
    "summon_merge",
    {
      title: "Finalize a summon-agents run held for review",
      description:
        "Finalize a run that was held by review=true: fast-forward the base branch onto the reviewed integration branch (no remote) or open a PR (remote present). ONLY call this after the HUMAN user has looked at the diff and explicitly told you to merge. Never call it based on your own review - the whole point of the gate is human approval.",
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
      title: "Live progress of a summon-agents run",
      description:
        "Open the window on a run: per-agent live progress - state, elapsed time, how long each has been quiet, and the files it has changed so far. Defaults to the latest run if no id is given. Read-only.",
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe("A run id, or omit for the latest run."),
      },
    },
    async ({ runId }) => {
      const p = await collectProgress(repoRoot, runId);
      return text(p ? formatProgress(p) : "no runs yet");
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
