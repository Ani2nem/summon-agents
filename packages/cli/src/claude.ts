// claude.ts - the CLI's Judge and AgentRunner, backed by the `claude` CLI.
//
// Under MCP the host model is the Judge; under this CLI (invoked by a hook, with
// no host model in the loop) we shell out to `claude -p` for the judgment calls
// and to run each agent headlessly in its worktree.
//
// NOTE (build-time open item from the plan): the exact headless permission flag
// for full autonomy is configurable here. `--permission-mode` is the documented
// path; the more aggressive skip flag is an opt-in escape hatch via env.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execa } from "execa";
import {
  type AgentCommand,
  type ConflictContext,
  type Judge,
  type TriageDecision,
  TriageDecisionSchema,
  singleDecision,
} from "@summon-agents/core";

/** How to invoke the underlying agent CLI. Overridable via env for other CLIs. */
export interface AgentCliConfig {
  /** The agent binary, default "claude". */
  bin: string;
  /** Permission mode flag value, default "acceptEdits" (autonomous edits). */
  permissionMode: string;
  /** If set, pass --dangerously-skip-permissions instead (full yolo). */
  skipPermissions: boolean;
}

export function agentConfigFromEnv(env = process.env): AgentCliConfig {
  return {
    bin: env.SUMMON_AGENT_BIN || "claude",
    permissionMode: env.SUMMON_PERMISSION_MODE || "acceptEdits",
    skipPermissions: env.SUMMON_YOLO === "1",
  };
}

function permissionArgs(cfg: AgentCliConfig): string[] {
  return cfg.skipPermissions
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", cfg.permissionMode];
}

/**
 * Build the command that runs one agent headlessly in its worktree. It reads its
 * task from the INSTRUCTIONS.md we wrote into the run dir.
 */
export function claudeCommandBuilder(cfg: AgentCliConfig) {
  return (ctx: { runDir: string }): AgentCommand => {
    const instructionsPath = path.join(ctx.runDir, "INSTRUCTIONS.md");
    // The agent is launched with cwd = worktree; read the prompt from the file.
    const prompt = `Read the task in ${instructionsPath} and implement it. Commit your work when done.`;
    return {
      command: cfg.bin,
      args: ["-p", prompt, ...permissionArgs(cfg)],
    };
  };
}

const TRIAGE_SYSTEM = `You are the planning brain of summon-agents. Given an approved implementation plan, decide whether the work should be split into parallel agents.

Respond with ONLY a JSON object (no prose, no code fence) matching:
{
  "mode": "split" | "single",
  "reason": "one line",
  "subtasks": [
    { "slug": "kebab-case", "title": "...", "instructions": "the slice of the plan for this task", "allowedFiles": ["glob or path", ...] }
  ],
  "hotspotFiles": ["package.json", ...],
  "preInstall": ["dependency", ...]
}

Rules:
- Split ONLY when there are multiple pieces of work touching NON-OVERLAPPING sets of files.
- If the work is small, or the pieces share files, use "single" with exactly one subtask.
- allowedFiles is each task's disjoint lane. Do not let two tasks share a code file.
- Put shared manifests/lockfiles/schemas in hotspotFiles, not in any lane.`;

/** Parse the first JSON object out of a model's text response. */
export function parseTriageResponse(text: string, plan: string): TriageDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return singleDecision(plan, "could not parse triage output; single agent");
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return TriageDecisionSchema.parse(obj);
  } catch {
    return singleDecision(plan, "invalid triage JSON; single agent");
  }
}

/** A Judge backed by `claude -p`. */
export function claudeJudge(cfg: AgentCliConfig): Judge {
  return {
    async triage(plan: string, repoDir: string): Promise<TriageDecision> {
      const res = await execa(
        cfg.bin,
        [
          "-p",
          `${TRIAGE_SYSTEM}\n\n--- PLAN ---\n${plan}`,
          ...permissionArgs(cfg),
        ],
        { cwd: repoDir, reject: false },
      );
      if (res.exitCode !== 0) {
        return singleDecision(plan, "triage call failed; single agent");
      }
      return parseTriageResponse(res.stdout, plan);
    },

    async resolveConflict(ctx: ConflictContext): Promise<boolean> {
      const task =
        ctx.validationOutput !== undefined
          ? `The merged code fails its validation command. Fix the code in ${ctx.repoDir} so validation passes. Do not weaken or delete tests. Validation output:\n${ctx.validationOutput}`
          : `Resolve the git merge conflicts in these files by preserving the intent of BOTH sides: ${ctx.conflictedFiles.join(
              ", ",
            )}. Remove all conflict markers. Do not discard either side's work.`;
      const res = await execa(
        cfg.bin,
        ["-p", task, ...permissionArgs(cfg)],
        { cwd: ctx.repoDir, reject: false },
      );
      return res.exitCode === 0;
    },
  };
}

/** True if the configured agent binary is on PATH. */
export async function agentAvailable(cfg: AgentCliConfig): Promise<boolean> {
  const res = await execa(cfg.bin, ["--version"], { reject: false });
  return res.exitCode === 0;
}

/** Read a plan from a file path, or return the string directly if not a file. */
export async function resolvePlan(planOrPath: string): Promise<string> {
  try {
    return await fs.readFile(planOrPath, "utf8");
  } catch {
    return planOrPath;
  }
}
