// agent-cli.ts - a Judge and AgentRunner backed by a headless coding-agent CLI.
//
// This is the default judgment + execution adapter, shared by the CLI and the
// MCP server. It shells out to an agent CLI - the same way the rest of core
// shells out to `git`/`gh`. Under the CLI there is no host model, so this is the
// Judge; the dispatched worker agents also run through this binary.
//
// The vendor is selectable so that WHO summoned decides WHO does the work:
// triggered from Claude Code -> `claude` workers, from Cursor -> `cursor-agent`,
// from Copilot -> `copilot`. `init` bakes SUMMON_AGENT_VENDOR into each host's
// MCP registration, so the right vendor is picked automatically per editor.

import { execa } from "execa";
import type { AgentCommand } from "./dispatch.js";
import type { ConflictContext, Judge, Subtask, TriageDecision } from "./ports.js";
import { TriageDecisionSchema } from "./ports.js";
import { singleDecision } from "./triage.js";

/** Which vendor's headless agent CLI runs the triage + worker agents. */
export type AgentVendor = "claude" | "cursor" | "copilot";

/** How to invoke the underlying agent CLI. */
export interface AgentCliConfig {
  /** Which vendor profile to use (default "claude"). */
  vendor: AgentVendor;
  /** The agent binary (defaults to the vendor's, overridable via SUMMON_AGENT_BIN). */
  bin: string;
  /** Permission mode flag value, default "bypassPermissions" (Claude only). */
  permissionMode: string;
  /** If set, request the most permissive / auto-approve mode (full yolo). */
  skipPermissions: boolean;
}

/**
 * Per-vendor knowledge: the default binary, how to run one headless auto-approved
 * prompt, and how to check availability. All three vendors expose a
 * "run this prompt non-interactively and exit" mode; the flags differ.
 *
 * Vendor CLIs move fast, so if a flag drifts on your version, point
 * SUMMON_AGENT_BIN at a wrapper or a newer binary rather than editing this.
 */
interface VendorProfile {
  bin: string;
  runArgs: (prompt: string, cfg: AgentCliConfig) => string[];
  versionArgs: string[];
}

const VENDORS: Record<AgentVendor, VendorProfile> = {
  // Claude Code. `-p` is headless print mode; `--permission-mode
  // bypassPermissions` (or `--dangerously-skip-permissions` for yolo) runs
  // unattended. This is the verified, default path.
  claude: {
    bin: "claude",
    runArgs: (prompt, cfg) => [
      "-p",
      prompt,
      ...(cfg.skipPermissions
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", cfg.permissionMode]),
    ],
    versionArgs: ["--version"],
  },
  // Cursor's headless CLI. `-p` runs non-interactively; `--force` auto-approves
  // edits/commands, which unattended worktree runs require.
  cursor: {
    bin: "cursor-agent",
    runArgs: (prompt) => ["-p", prompt, "--force"],
    versionArgs: ["--version"],
  },
  // GitHub Copilot CLI (newer / experimental). `-p` prompt, `--allow-all-tools`
  // for unattended execution.
  copilot: {
    bin: "copilot",
    runArgs: (prompt) => ["-p", prompt, "--allow-all-tools"],
    versionArgs: ["--version"],
  },
};

/** Map a host/vendor string (from env or a host name) to a vendor profile. */
export function normalizeVendor(v: string | undefined): AgentVendor {
  switch ((v ?? "").toLowerCase()) {
    case "cursor":
    case "cursor-agent":
      return "cursor";
    case "copilot":
    case "github-copilot":
      return "copilot";
    default:
      return "claude";
  }
}

export function agentConfigFromEnv(env = process.env): AgentCliConfig {
  const vendor = normalizeVendor(env.SUMMON_AGENT_VENDOR);
  return {
    vendor,
    // SUMMON_AGENT_BIN wins so any vendor's binary can be swapped without code.
    bin: env.SUMMON_AGENT_BIN || VENDORS[vendor].bin,
    // Fully unattended by default (Claude): dispatched agents run in isolated
    // worktrees and must not stall on mid-task prompts. Override with
    // SUMMON_PERMISSION_MODE (e.g. "acceptEdits") for a more cautious run.
    permissionMode: env.SUMMON_PERMISSION_MODE || "bypassPermissions",
    skipPermissions: env.SUMMON_YOLO === "1",
  };
}

/** The args to run one headless, auto-approved prompt through the vendor CLI. */
export function agentRunArgs(cfg: AgentCliConfig, prompt: string): string[] {
  return VENDORS[cfg.vendor].runArgs(prompt, cfg);
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
- GREENFIELD/EMPTY repos (the plan note will say so): every split lane MUST be a self-contained SUBDIRECTORY that owns everything under it - its own code AND its own package.json/config/lockfile (e.g. "frontend/**", "backend/**"). Do NOT split repository-ROOT setup across lanes: two agents both scaffolding at the root collide. If the plan needs shared repo-root setup (a root workspace/monorepo package.json, root tooling config), either keep the whole plan as a SINGLE agent, or hand that root setup to exactly ONE lane. When the bootstrap is small or the pieces share root scaffolding, prefer "single".
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

/**
 * Build the command that runs one agent headlessly in its worktree.
 *
 * The task is embedded directly in the prompt - NOT read from a file. Sandboxed
 * vendor CLIs (Copilot, Cursor) only allow file access inside their working
 * directory, so pointing them at an INSTRUCTIONS.md that lives outside the
 * worktree (in the run dir) silently fails: the agent can't read it, does
 * nothing, and exits clean. Inlining the task sidesteps that for every vendor.
 */
export function agentCommandBuilder(cfg: AgentCliConfig) {
  return (ctx: { subtask: Subtask; runDir: string }): AgentCommand => {
    // With a lane, keep the agent strictly inside its subtree - including any
    // scaffolding. Greenfield agents otherwise run `npm init` / `create-vite` at
    // the worktree ROOT (writing root package.json etc.), which lands outside the
    // lane and trips the out-of-lane backstop, aborting the whole run.
    const lane =
      ctx.subtask.allowedFiles.length > 0
        ? `\n\nYOUR LANE - create or modify files ONLY within these paths, never at the repository root or in another lane:\n${ctx.subtask.allowedFiles
            .map((f) => `- ${f}`)
            .join(
              "\n",
            )}\n\nIf you need to initialize or scaffold (npm init, create-vite, framework or project generators, etc.), do it INSIDE your lane directory - create the directory and run the tool there (e.g. \`mkdir -p <your-lane-dir> && cd <your-lane-dir>\`) or point the generator at that path. Never run a scaffolder at the repository root. Every file you create must live under one of the lane paths above.`
        : "";
    const prompt = `You are implementing ONE task directly in the current working directory (a git worktree). Make the changes here, then commit them with git. Work autonomously - do not ask for confirmation or wait for input.

# Task: ${ctx.subtask.title}

${ctx.subtask.instructions}${lane}

## How to work (important)
- Write the code, then COMMIT it with git as soon as the implementation is complete - commit BEFORE any optional verification, so your work is never lost.
- Do NOT run heavy or manual verification yourself: no browser / end-to-end testing, no long-running servers (\`npm start\`, dev servers), no large simulation gauntlets. The orchestrator runs the project's own typecheck / build / test on the merged result - that is where validation happens, not here. A quick local sanity check is fine; extensive verification is not your job and it makes the run look stalled.
- Keep making steady, visible progress. If you finish early, commit and stop rather than polishing indefinitely.`;
    return {
      command: cfg.bin,
      args: agentRunArgs(cfg, prompt),
    };
  };
}

/** A Judge backed by a headless agent CLI (the configured vendor). */
export function agentJudge(cfg: AgentCliConfig): Judge {
  return {
    async triage(plan: string, repoDir: string): Promise<TriageDecision> {
      const res = await execa(
        cfg.bin,
        agentRunArgs(cfg, `${TRIAGE_SYSTEM}\n\n--- PLAN ---\n${plan}`),
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
      const res = await execa(cfg.bin, agentRunArgs(cfg, task), {
        cwd: ctx.repoDir,
        reject: false,
      });
      return res.exitCode === 0;
    },
  };
}

/** True if the configured agent binary is on PATH. */
export async function agentAvailable(cfg: AgentCliConfig): Promise<boolean> {
  const res = await execa(cfg.bin, VENDORS[cfg.vendor].versionArgs, {
    reject: false,
  });
  return res.exitCode === 0;
}
