// agent-cli.ts - a Judge and AgentRunner backed by a headless coding-agent CLI.
//
// This is the default judgment + execution adapter, shared by the CLI and the
// MCP server. It shells out to an agent CLI (`claude -p` by default, or any
// binary via SUMMON_AGENT_BIN) - the same way the rest of core shells out to
// `git`/`gh`. Under the CLI there is no host model, so this is the Judge; the
// dispatched worker agents also run through this binary.

import { execa } from "execa";
import * as path from "node:path";
import type { AgentCommand } from "./dispatch.js";
import type { ConflictContext, Judge, TriageDecision } from "./ports.js";
import { TriageDecisionSchema } from "./ports.js";
import { singleDecision } from "./triage.js";

/** How to invoke the underlying agent CLI. Overridable via env for other CLIs. */
export interface AgentCliConfig {
  /** The agent binary, default "claude". */
  bin: string;
  /** Permission mode flag value, default "bypassPermissions" (fully unattended). */
  permissionMode: string;
  /** If set, pass --dangerously-skip-permissions instead (full yolo). */
  skipPermissions: boolean;
}

export function agentConfigFromEnv(env = process.env): AgentCliConfig {
  return {
    bin: env.SUMMON_AGENT_BIN || "claude",
    // Fully unattended by default (the agreed design): dispatched agents run in
    // isolated worktrees and must not stall on mid-task prompts. Override with
    // SUMMON_PERMISSION_MODE (e.g. "acceptEdits") for a more cautious run.
    permissionMode: env.SUMMON_PERMISSION_MODE || "bypassPermissions",
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
- COVER THE WHOLE PLAN. Every file the plan says to create or modify must be owned by exactly one subtask's allowedFiles. Never drop a planned change.
- Shared CODE files that need real edits (an entry point like index.js, a barrel/index, a shared types file, a router that wires features together) are NOT hotspots. Assign such a file - and the wiring work for it - to exactly ONE subtask (typically the task it most depends on), or keep the whole plan as a single agent if the wiring cannot be cleanly assigned. Do not leave wiring unowned.
- Only put files that need NO real logic edits - manifests, lockfiles, generated schemas - in hotspotFiles.
- Before responding, check: does the union of all subtasks' allowedFiles cover every file the plan mentions? If not, fix the split or use "single".`;

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

/** A Judge backed by a headless agent CLI (`claude -p` by default). */
export function claudeJudge(cfg: AgentCliConfig): Judge {
  return {
    async triage(plan: string, repoDir: string): Promise<TriageDecision> {
      const res = await execa(
        cfg.bin,
        ["-p", `${TRIAGE_SYSTEM}\n\n--- PLAN ---\n${plan}`, ...permissionArgs(cfg)],
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
      const res = await execa(cfg.bin, ["-p", task, ...permissionArgs(cfg)], {
        cwd: ctx.repoDir,
        reject: false,
      });
      return res.exitCode === 0;
    },
  };
}

/** True if the configured agent binary is on PATH. */
export async function agentAvailable(cfg: AgentCliConfig): Promise<boolean> {
  const res = await execa(cfg.bin, ["--version"], { reject: false });
  return res.exitCode === 0;
}
