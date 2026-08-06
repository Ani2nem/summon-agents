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
 * A final, SEQUENTIAL integration step. Parallel lanes are built blind (each
 * agent sees only its own lane), so anything that must tie the finished pieces
 * together - a shared entry point, an HTTP server that serves several pages, a
 * router that composes independently-built features - cannot be written
 * correctly inside any one lane. This step runs ONCE, AFTER all lanes have
 * merged, in a worktree that contains every piece, so it can read the real
 * routes/exports the pieces expose and wire the shared surface to match. This is
 * the cure for the "each agent invents its own server and they collide" class of
 * bug: the shared surface is built once, with full sight, instead of N times blind.
 */
export const IntegrationTaskSchema = z.object({
  /** Human-readable title, surfaced to the user. */
  title: z.string().min(1).default("Integrate the parallel work"),
  /** What shared surface to wire up once the lanes are merged. */
  instructions: z.string().min(1),
});
export type IntegrationTask = z.infer<typeof IntegrationTaskSchema>;

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
  /**
   * Optional final integration step (split runs only). Set when the lanes share
   * a foundation that only makes sense once every piece exists (an entry point,
   * a server serving several pages, a router composing features). Null when the
   * lanes are truly independent and need no wiring - then this step is skipped.
   */
  integration: IntegrationTaskSchema.nullable().default(null),
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
  // 0 on the tmux launch path (no meaningful trampoline pid; the session is the
  // handle instead). Positive on the detached-spawn fallback.
  pid: z.number().int().nonnegative(),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  startedAt: z.string(), // ISO 8601, also guards against PID reuse
  /**
   * The tmux session this agent runs in, when tmux is available. Absent on the
   * detached-spawn fallback path, in which case supervision reaps by `pid`.
   */
  tmuxSession: z.string().optional(),
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
  | "awaitingReview" // merged+validated on the integration branch; --review gate,
  // waiting for the user to finalize (ff base / open PR). NON-terminal.
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

/**
 * Terminal states that trigger cleanup of worktrees/branches. Note this excludes
 * "needsHuman": that state means "stop for a human to look", so we must preserve
 * the worktrees, branches, and integration branch for inspection - deleting them
 * would destroy the very thing the human needs to see.
 */
export const CLEANUP_STATUSES: readonly RunStatus[] = [
  "completed",
  "aborted",
  "failed",
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function triggersCleanup(status: RunStatus): boolean {
  return CLEANUP_STATUSES.includes(status);
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

/** Context handed to the Judge for the final integration step. */
export interface IntegrationContext {
  /**
   * A worktree holding EVERY merged lane. The integrator reads the real pieces
   * here and wires the shared surface to match, then commits. Its own dir, so a
   * broad `git add -A` cannot sweep the user's untracked files.
   */
  repoDir: string;
  /** The full approved plan, for cross-cutting context. */
  plan: string;
  /** What shared surface to wire up (from the triage integration task). */
  instructions: string;
  /** The lane slugs whose work was merged and is present to integrate. */
  mergedSlugs: string[];
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
  /**
   * OPTIONAL final integration pass over the merged tree: wire the shared surface
   * the parallel lanes couldn't build blind (a server, router, entry point).
   * Resolves true if it did its work, false to give up (-> needsHuman). Optional
   * so existing Judges/fakes that predate integration keep compiling; when a
   * Judge does not implement it, the integration step is skipped.
   */
  integrate?(ctx: IntegrationContext): Promise<boolean>;
}

/** A handle to a launched agent process. */
export interface AgentHandle {
  slug: string;
  pid: number;
  /** The tmux session it runs in, when launched under tmux. */
  tmuxSession?: string;
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
    /** The run this agent belongs to, used to name its tmux session. */
    runId?: string;
  }): Promise<AgentHandle>;
}

/** Result of attempting to open a PR. */
export interface PrResult {
  opened: boolean;
  /** URL if opened. */
  url?: string;
  /**
   * The branch pushed to the remote (set whenever we pushed, whether or not a PR
   * was also opened). The host will offer to open a PR/MR for it.
   */
  pushedBranch?: string;
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
  /**
   * Push `branch` to origin with plain git (no PR tool required). Returns a
   * create-PR/MR hint URL if the remote printed one. This is the universal path:
   * any host offers PR/MR creation after a branch is pushed.
   */
  pushBranch(
    repoDir: string,
    branch: string,
  ): Promise<{ ok: boolean; hint?: string }>;
  /**
   * True if `branch` exists on the remote. Used to detect a fresh remote (nothing
   * pushed yet) so the PR base branch can be established before pushing the work.
   */
  remoteHasBranch(repoDir: string, branch: string): Promise<boolean>;
  /** True if the PR tool (gh/glab) is installed and authenticated. */
  canOpenPr(repoDir: string): Promise<boolean>;
  /** Open a PR for `branch` (already pushed) against the base, degrading gracefully. */
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
