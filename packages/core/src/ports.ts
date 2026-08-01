// ports.ts - the seam that lets one core run two ways.
//
// The mechanics (git worktrees, process spawning, merging) live in core and are
// concrete. The *judgment* (should this split? how do these conflicts resolve?)
// and the *outward-facing* effects (PR creation, notifications) are behind
// interfaces so that:
//   - under MCP, the host model is the Judge and the host environment supplies effects;
//   - under the CLI, the Judge shells out to a coding-agent CLI (`claude -p`);
//   - under tests, everything is a deterministic fake.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single unit of parallelizable work carved out of an approved plan. */
export const SubtaskSchema = z.object({
  /** Stable, filesystem- and branch-safe identifier, e.g. "auth-flow". */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case"),
  /** Human-readable title. */
  title: z.string().min(1),
  /** The slice of the plan this subtask is responsible for. */
  instructions: z.string().min(1),
  /**
   * The files/globs this subtask is allowed to touch. This is the disjointness
   * contract; out-of-lane edits are flagged before merge (loophole C backstop).
   */
  allowedFiles: z.array(z.string()).default([]),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

/**
 * The brake's output. Either the work is not worth splitting (a single focused
 * agent runs it) or it is decomposed into disjoint subtasks plus any shared
 * "hotspot" files that must be kept out of the parallel lanes (loophole C).
 */
export const TriageDecisionSchema = z.object({
  /** "split" => run subtasks in parallel; "single" => one worktree/agent. */
  mode: z.enum(["split", "single"]),
  /** One-line justification, surfaced to the user. */
  reason: z.string().min(1),
  /** The work units. For "single" this is exactly one. */
  subtasks: z.array(SubtaskSchema).min(1),
  /**
   * Shared files every lane might touch (package.json, lockfiles, schemas,
   * migrations, barrel indexes, DI registries). Reserved out of parallel lanes.
   */
  hotspotFiles: z.array(z.string()).default([]),
  /**
   * Dependencies to install once, up front, before dispatch, so agents do not
   * each race to edit the manifest/lockfile (loophole C).
   */
  preInstall: z.array(z.string()).default([]),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

/** Terminal status an individual agent reports via result.json. */
export const AgentResultSchema = z.object({
  slug: z.string().min(1),
  status: z.enum(["success", "error"]),
  exitCode: z.number().int().nullable(),
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  endedAt: z.string(), // ISO 8601
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

/** Bookkeeping for one launched agent process (persisted to agents.json). */
export const AgentRecordSchema = z.object({
  slug: z.string().min(1),
  pid: z.number().int().positive(),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  startedAt: z.string(), // ISO 8601, also guards against PID reuse
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

/**
 * Run lifecycle. Cleanup of worktrees/branches is guaranteed on every *terminal*
 * state (completed, needsHuman, aborted, failed), not just success.
 */
export type RunStatus =
  | "created" // run allocated, nothing dispatched yet
  | "dispatched" // agents launched, running
  | "merging" // agents done, boss merge + validation underway
  | "completed" // merged locally + PR opened (or handed off), done
  | "needsHuman" // a gate failed (bad merge, validation, conflicts) - stop
  | "aborted" // user/tool aborted
  | "failed"; // unexpected error

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "needsHuman",
  "aborted",
  "failed",
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Persisted state for a run (run.json). */
export const RunStateSchema = z.object({
  runId: z.string().min(1),
  status: z.custom<RunStatus>(),
  /** The raw approved plan text this run was created from. */
  plan: z.string(),
  /** The base branch subtask branches fork from and merge back into. */
  baseBranch: z.string().min(1),
  decision: TriageDecisionSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunState = z.infer<typeof RunStateSchema>;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Context handed to the Judge when resolving a merge conflict. */
export interface ConflictContext {
  slug: string;
  /** Files with conflict markers after attempting the merge. */
  conflictedFiles: string[];
  /** The repository root the Judge should operate in. */
  repoDir: string;
  /** Optional validation output that must be made to pass (loophole A). */
  validationOutput?: string;
}

/**
 * The LLM judgment layer. Under MCP the host model implements this; under the
 * CLI it shells out to a coding-agent CLI; under tests it is a deterministic fake.
 */
export interface Judge {
  /** The brake + decomposition + hotspot pass over an approved plan. */
  triage(plan: string, repoDir: string): Promise<TriageDecision>;
  /**
   * Resolve a merge conflict (or a clean-but-broken validation failure) in place
   * in repoDir. Resolves true if it believes it fixed things, false to give up.
   */
  resolveConflict(ctx: ConflictContext): Promise<boolean>;
}

/** A handle to a launched agent process. */
export interface AgentHandle {
  slug: string;
  pid: number;
}

/**
 * Launches a coding agent to execute one subtask inside its worktree. The
 * contract: the agent (or a trampoline wrapping it) writes result.json into the
 * worktree's run directory on completion, even on crash. Real impl spawns
 * `claude -p`; tests spawn a deterministic stub script.
 */
export interface AgentRunner {
  launch(input: {
    subtask: Subtask;
    worktreeDir: string;
    /** Where the agent must write stdout.log / stderr.log / result.json. */
    runDir: string;
  }): Promise<AgentHandle>;
}

/** Result of attempting to open a PR. */
export interface PrResult {
  opened: boolean;
  /** URL if opened. */
  url?: string;
  /**
   * If not opened (no remote, no auth), the exact command the user can run to do
   * it themselves. The tool degrades gracefully rather than failing.
   */
  manualCommand?: string;
  reason?: string;
}

/**
 * Outward-facing VCS effects that cannot run in CI and must be fakeable. Local
 * git (worktree/merge/commit) is concrete elsewhere; this is only the parts that
 * reach the network / a remote host.
 */
export interface Vcs {
  /** True if the repo has a push remote configured. */
  hasRemote(repoDir: string): Promise<boolean>;
  /** True if the PR tool (gh/glab) is installed and authenticated. */
  canOpenPr(repoDir: string): Promise<boolean>;
  /** Open a PR for `branch` against the base, degrading gracefully. */
  openPr(input: {
    repoDir: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PrResult>;
}

/** How completion/status is surfaced (desktop notification, stdout, MCP event). */
export interface Notifier {
  info(message: string): void;
  agentDone(result: AgentResult): void;
  runDone(state: RunState, summary: string): void;
}
