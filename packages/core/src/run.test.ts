import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TriageDecision } from "./ports.js";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";
import {
  acquireLock,
  branchNameFor,
  cleanupRun,
  createRun,
  findLatestRun,
  gc,
  loadRun,
  newRunId,
  releaseLock,
  runIdFromBranch,
  saveRun,
  setRunStatus,
  worktreePathFor,
} from "./run.js";
import { addWorktree, branchExists, listWorktrees } from "./worktree.js";

describe("run lock (idempotency - loophole D)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("second acquire while a live lock is held returns false", async () => {
    expect(await acquireLock(repo, "run-a")).toBe(true);
    // Same process holds it and is alive, so a second attempt is refused.
    expect(await acquireLock(repo, "run-b")).toBe(false);
    await releaseLock(repo);
    expect(await acquireLock(repo, "run-c")).toBe(true);
  });

  it("steals a stale lock left by a dead pid", async () => {
    // Forge a lock file owned by a pid that cannot be alive.
    const { lockPath, stateRoot } = await import("./run.js");
    await fs.mkdir(stateRoot(repo), { recursive: true });
    await fs.writeFile(
      lockPath(repo),
      JSON.stringify({ runId: "old", pid: 2 ** 22, acquiredAt: "x" }),
    );
    expect(await acquireLock(repo, "fresh")).toBe(true);
  });
});

describe("run state + branch naming", () => {
  it("branch naming round-trips runId", () => {
    const b = branchNameFor("run-xyz", "auth");
    expect(b).toBe("summon/run-xyz/auth");
    expect(runIdFromBranch(b)).toBe("run-xyz");
    expect(runIdFromBranch("feature/x")).toBeNull();
  });

  it("newRunId is unique-ish and filesystem safe", () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[:.]/);
  });
});

describe("findLatestRun", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  async function seed(runId: string, status: import("./ports.js").RunStatus) {
    const state = await createRun({
      repoRoot: repo,
      plan: "p",
      baseBranch: "main",
      runId,
    });
    if (status !== "created") {
      await setRunStatus({ repoRoot: repo, state, status });
    }
    return state;
  }

  it("returns null when no run matches", async () => {
    await seed("2026-01-01-a", "created");
    expect(
      await findLatestRun(repo, (s) => s.status === "awaitingReview"),
    ).toBeNull();
    // and null when there are no runs at all
    const empty = await makeTempRepo();
    expect(await findLatestRun(empty, () => true)).toBeNull();
    await cleanupTempRepo(empty);
  });

  it("returns the most recent run satisfying the predicate", async () => {
    // Timestamp-prefixed ids sort chronologically.
    await seed("2026-01-01-a", "awaitingReview");
    await seed("2026-01-02-b", "completed");
    await seed("2026-01-03-c", "awaitingReview");
    await seed("2026-01-04-d", "completed");

    const review = await findLatestRun(
      repo,
      (s) => s.status === "awaitingReview",
    );
    expect(review?.runId).toBe("2026-01-03-c");

    const active = await findLatestRun(
      repo,
      (s) => s.status !== "completed" && s.status !== "aborted",
    );
    expect(active?.runId).toBe("2026-01-03-c");
  });
});

describe("cleanup on every terminal state", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  const decisionWith = (slugs: string[]): TriageDecision => ({
    mode: slugs.length > 1 ? "split" : "single",
    reason: "test",
    subtasks: slugs.map((slug) => ({
      slug,
      title: slug,
      instructions: "do the thing",
      allowedFiles: [],
    })),
    hotspotFiles: [],
    preInstall: [],
  });

  async function seedRunWithWorktrees(runId: string, slugs: string[]) {
    let state = await createRun({
      repoRoot: repo,
      plan: "plan",
      baseBranch: "main",
      runId,
    });
    state = { ...state, decision: decisionWith(slugs) };
    await saveRun(repo, state);
    for (const slug of slugs) {
      await addWorktree({
        repoDir: repo,
        worktreePath: worktreePathFor(repo, runId, slug),
        branch: branchNameFor(runId, slug),
        baseBranch: "main",
      });
    }
    return state;
  }

  it.each(["completed", "aborted", "failed"] as const)(
    "removes worktrees and branches when transitioning to %s",
    async (status) => {
      const state = await seedRunWithWorktrees(`run-${status}`, [
        "auth",
        "api",
      ]);
      expect(await branchExists(repo, branchNameFor(state.runId, "auth"))).toBe(
        true,
      );

      await setRunStatus({ repoRoot: repo, state, status });

      expect(await branchExists(repo, branchNameFor(state.runId, "auth"))).toBe(
        false,
      );
      expect(await branchExists(repo, branchNameFor(state.runId, "api"))).toBe(
        false,
      );
      const remaining = (await listWorktrees(repo)).filter((e) =>
        e.path.includes(state.runId),
      );
      expect(remaining).toHaveLength(0);
    },
  );

  it("PRESERVES worktrees and branches on needsHuman (for inspection)", async () => {
    const state = await seedRunWithWorktrees("run-needshuman", ["auth"]);
    await setRunStatus({ repoRoot: repo, state, status: "needsHuman" });
    expect(await branchExists(repo, branchNameFor(state.runId, "auth"))).toBe(
      true,
    );
    const remaining = (await listWorktrees(repo)).filter((e) =>
      e.path.includes(state.runId),
    );
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("cleanupRun is idempotent", async () => {
    const state = await seedRunWithWorktrees("run-idem", ["auth"]);
    await cleanupRun({ repoRoot: repo, state });
    await expect(cleanupRun({ repoRoot: repo, state })).resolves.toBeUndefined();
  });
});

describe("gc reaps orphans from dead runs", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("removes a worktree/branch whose run has no live run.json", async () => {
    // Simulate a dead prior run: worktree + branch exist, but no run record.
    const runId = "dead-run";
    await addWorktree({
      repoDir: repo,
      worktreePath: worktreePathFor(repo, runId, "orphan"),
      branch: branchNameFor(runId, "orphan"),
      baseBranch: "main",
    });
    expect(await branchExists(repo, branchNameFor(runId, "orphan"))).toBe(true);

    const reaped = await gc(repo);

    expect(reaped.branchesDeleted).toContain(branchNameFor(runId, "orphan"));
    expect(await branchExists(repo, branchNameFor(runId, "orphan"))).toBe(false);
  });

  it("leaves an active run's worktree alone", async () => {
    const runId = "live-run";
    await createRun({
      repoRoot: repo,
      plan: "p",
      baseBranch: "main",
      runId,
    }); // status "created" => non-terminal => live
    await addWorktree({
      repoDir: repo,
      worktreePath: worktreePathFor(repo, runId, "keep"),
      branch: branchNameFor(runId, "keep"),
      baseBranch: "main",
    });

    await gc(repo);

    expect(await branchExists(repo, branchNameFor(runId, "keep"))).toBe(true);
  });
});
