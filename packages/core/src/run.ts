// run.ts - run lifecycle, on-disk layout, idempotency lock, and cleanup.
//
// Everything a run needs is files under <repo>/.summon-agents/, so runs survive
// the parent process exiting and can be inspected/reaped later. Cleanup of
// worktrees and branches is guaranteed on *every* terminal state, and a gc sweep
// reaps orphans left by prior dead runs.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type RunState,
  RunStateSchema,
  type RunStatus,
  isTerminal,
  triggersCleanup,
} from "./ports.js";
import {
  deleteBranch,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const STATE_DIR = ".summon-agents";

export function stateRoot(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR);
}
export function lockPath(repoRoot: string): string {
  return path.join(stateRoot(repoRoot), "lock.json");
}
export function runsRoot(repoRoot: string): string {
  return path.join(stateRoot(repoRoot), "runs");
}
export function runDir(repoRoot: string, runId: string): string {
  return path.join(runsRoot(repoRoot), runId);
}
export function agentRunDir(
  repoRoot: string,
  runId: string,
  slug: string,
): string {
  return path.join(runDir(repoRoot, runId), slug);
}
export function worktreesRoot(repoRoot: string): string {
  return path.join(stateRoot(repoRoot), "worktrees");
}
export function worktreePathFor(
  repoRoot: string,
  runId: string,
  slug: string,
): string {
  return path.join(worktreesRoot(repoRoot), runId, slug);
}

/** Branch naming: summon/<runId>/<slug>. Central to gc's orphan detection. */
export function branchNameFor(runId: string, slug: string): string {
  return `summon/${runId}/${slug}`;
}
export function runIdFromBranch(branch: string): string | null {
  const m = /^summon\/([^/]+)\/[^/]+$/.exec(branch);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Idempotency lock (loophole D)
// ---------------------------------------------------------------------------

interface LockInfo {
  runId: string;
  pid: number;
  acquiredAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process; EPERM => exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the run lock. Returns true if acquired. If another run's lock is held
 * by a live process, returns false (the caller should exit 0 - loophole D). A
 * stale lock left by a dead process is stolen.
 */
export async function acquireLock(
  repoRoot: string,
  runId: string,
): Promise<boolean> {
  const lp = lockPath(repoRoot);
  await fs.mkdir(stateRoot(repoRoot), { recursive: true });
  const payload: LockInfo = {
    runId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  try {
    // wx => fail if it already exists (atomic create).
    const handle = await fs.open(lp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    await handle.writeFile(JSON.stringify(payload, null, 2));
    await handle.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Lock exists: steal it only if the holder is dead (stale lock).
  const existing = await readLock(repoRoot);
  if (existing && pidAlive(existing.pid)) return false;
  await fs.writeFile(lp, JSON.stringify(payload, null, 2));
  return true;
}

export async function readLock(repoRoot: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath(repoRoot), "utf8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/** Release the lock if this process holds it. */
export async function releaseLock(repoRoot: string): Promise<void> {
  const existing = await readLock(repoRoot);
  if (existing && existing.pid !== process.pid) return; // not ours; leave it
  await fs.rm(lockPath(repoRoot), { force: true });
}

// ---------------------------------------------------------------------------
// Run state persistence + transitions
// ---------------------------------------------------------------------------

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function runStatePath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "run.json");
}

export async function createRun(input: {
  repoRoot: string;
  plan: string;
  baseBranch: string;
  runId?: string;
  now?: Date;
}): Promise<RunState> {
  const now = input.now ?? new Date();
  const runId = input.runId ?? newRunId(now);
  const iso = now.toISOString();
  const state: RunState = {
    runId,
    status: "created",
    plan: input.plan,
    baseBranch: input.baseBranch,
    decision: null,
    createdAt: iso,
    updatedAt: iso,
  };
  await fs.mkdir(runDir(input.repoRoot, runId), { recursive: true });
  await saveRun(input.repoRoot, state);
  return state;
}

export async function saveRun(
  repoRoot: string,
  state: RunState,
): Promise<void> {
  await fs.mkdir(runDir(repoRoot, state.runId), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  await fs.writeFile(
    runStatePath(repoRoot, state.runId),
    JSON.stringify(next, null, 2),
  );
}

export async function loadRun(
  repoRoot: string,
  runId: string,
): Promise<RunState | null> {
  try {
    const raw = await fs.readFile(runStatePath(repoRoot, runId), "utf8");
    return RunStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Transition a run to a new status. When the status is terminal, cleanup of the
 * run's worktrees and branches runs automatically - this is the single choke
 * point that guarantees no orphans regardless of *why* the run ended.
 */
export async function setRunStatus(input: {
  repoRoot: string;
  state: RunState;
  status: RunStatus;
}): Promise<RunState> {
  const next: RunState = { ...input.state, status: input.status };
  await saveRun(input.repoRoot, next);
  if (triggersCleanup(input.status)) {
    await cleanupRun({ repoRoot: input.repoRoot, state: next });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Cleanup + gc
// ---------------------------------------------------------------------------

/**
 * Remove this run's worktrees and delete its branches. Safe to call more than
 * once. Run logs under runs/<id>/ are kept for audit.
 */
export async function cleanupRun(input: {
  repoRoot: string;
  state: RunState;
}): Promise<void> {
  const { repoRoot, state } = input;
  const slugs = state.decision?.subtasks.map((s) => s.slug) ?? [];
  for (const slug of slugs) {
    await removeWorktree({
      repoDir: repoRoot,
      worktreePath: worktreePathFor(repoRoot, state.runId, slug),
    });
    await deleteBranch({
      repoDir: repoRoot,
      branch: branchNameFor(state.runId, slug),
    });
  }
  // The local integration branch (its commits are on base / pushed for the PR).
  await deleteBranch({
    repoDir: repoRoot,
    branch: `summon/${state.runId}/integration`,
  });
  await pruneWorktrees(repoRoot);
  // Remove the (now empty) per-run worktree directory if present.
  await fs.rm(path.join(worktreesRoot(repoRoot), state.runId), {
    recursive: true,
    force: true,
  });
}

/**
 * Sweep orphans left by prior dead runs: worktrees registered by git whose run
 * is no longer active, and summon/* branches whose run directory is gone or
 * terminal. Returns what it reaped. Used by `summon-agents gc` / on startup.
 */
export async function gc(repoRoot: string): Promise<{
  worktreesRemoved: string[];
  branchesDeleted: string[];
}> {
  const worktreesRemoved: string[] = [];
  const branchesDeleted: string[] = [];

  const activeRunIds = await liveRunIds(repoRoot);

  // Reap worktrees under our worktrees root that belong to non-active runs.
  // git reports canonicalized (realpath) paths, so canonicalize our root too or
  // the startsWith filter misses entries (e.g. macOS /var vs /private/var).
  const canonicalRoot = await fs.realpath(repoRoot).catch(() => repoRoot);
  const entries = await listWorktrees(repoRoot);
  const root = worktreesRoot(canonicalRoot);
  for (const entry of entries) {
    if (!entry.path.startsWith(root)) continue;
    const rel = path.relative(root, entry.path); // <runId>/<slug>
    const runId = rel.split(path.sep)[0];
    if (runId && !activeRunIds.has(runId)) {
      await removeWorktree({ repoDir: repoRoot, worktreePath: entry.path });
      worktreesRemoved.push(entry.path);
    }
  }
  await pruneWorktrees(repoRoot);

  // Reap summon/* branches whose run is not active.
  const { git } = await import("./worktree.js");
  const branchOut = await git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/summon",
  ]).catch(() => "");
  for (const branch of branchOut.split("\n").filter(Boolean)) {
    const runId = runIdFromBranch(branch);
    if (runId && !activeRunIds.has(runId)) {
      await deleteBranch({ repoDir: repoRoot, branch });
      branchesDeleted.push(branch);
    }
  }

  return { worktreesRemoved, branchesDeleted };
}

/**
 * Run ids gc must NOT reap: those still active, plus those in needsHuman (whose
 * worktrees/branches are deliberately preserved for a human to inspect).
 */
async function liveRunIds(repoRoot: string): Promise<Set<string>> {
  const keep = new Set<string>();
  let ids: string[] = [];
  try {
    ids = await fs.readdir(runsRoot(repoRoot));
  } catch {
    return keep;
  }
  for (const id of ids) {
    const state = await loadRun(repoRoot, id);
    if (!state) continue;
    if (!isTerminal(state.status) || state.status === "needsHuman") {
      keep.add(id);
    }
  }
  return keep;
}
