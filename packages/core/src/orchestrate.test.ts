import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecAgentRunner } from "./dispatch.js";
import { runPipeline } from "./orchestrate.js";
import type {
  AgentRunner,
  Judge,
  Notifier,
  PrResult,
  TriageDecision,
  Vcs,
} from "./ports.js";
import { acquireLock } from "./run.js";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";

/** Judge that splits into fixed lanes and never needs to resolve conflicts. */
function splittingJudge(decision: TriageDecision): Judge {
  return {
    async triage() {
      return decision;
    },
    async resolveConflict() {
      return false;
    },
  };
}

/** Runner whose agents write their lane file then exit 0. */
function writingRunner(): AgentRunner {
  return new ExecAgentRunner(({ subtask }) => ({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require("fs");fs.mkdirSync("src/${subtask.slug}",{recursive:true});fs.writeFileSync("src/${subtask.slug}/index.ts","export const ${subtask.slug}=1;\\n");`,
    ],
  }));
}

/** Vcs with no remote - PR degrades to a manual command. */
const noRemoteVcs: Vcs = {
  async hasRemote() {
    return false;
  },
  async canOpenPr() {
    return false;
  },
  async openPr(): Promise<PrResult> {
    return { opened: false };
  },
};

function silentNotifier(): Notifier {
  return {
    info() {},
    agentDone() {},
    runDone() {},
  };
}

const split2: TriageDecision = {
  mode: "split",
  reason: "two disjoint features",
  subtasks: [
    { slug: "auth", title: "Auth", instructions: "build auth", allowedFiles: ["src/auth/**"] },
    { slug: "api", title: "API", instructions: "build api", allowedFiles: ["src/api/**"] },
  ],
  hotspotFiles: [],
  preInstall: [],
};

describe("runPipeline (end to end with fakes)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("splits, dispatches, merges, and reports a manual PR command when no remote", async () => {
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-1", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("completed");
    expect(result.mergedSlugs?.sort()).toEqual(["api", "auth"]);
    expect(result.pr?.opened).toBe(false);
    expect(result.pr?.manualCommand).toContain("gh pr create");

    // Both lanes landed on base.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    // Cleanup ran: no orphan worktrees remain for this run.
    const { listWorktrees } = await import("./worktree.js");
    const remaining = (await listWorktrees(repo)).filter((e) =>
      e.path.includes("pipe-1"),
    );
    expect(remaining).toHaveLength(0);
  });

  it("skips when another run holds the lock (idempotency)", async () => {
    // Pre-acquire the lock as if a run were active.
    await acquireLock(repo, "other-run");
    const result = await runPipeline(
      repo,
      "Build stuff",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-2", watch: { intervalMs: 50 } },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/already active/i);
  });

  it("brake: a single-mode decision runs one agent (no fan-out)", async () => {
    const single: TriageDecision = {
      mode: "single",
      reason: "too small to split",
      subtasks: [
        { slug: "main", title: "Do it", instructions: "the whole thing", allowedFiles: [] },
      ],
      hotspotFiles: [],
      preInstall: [],
    };
    const result = await runPipeline(
      repo,
      "tiny change",
      {
        judge: splittingJudge(single),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-3", watch: { intervalMs: 50 } },
    );
    expect(result.status).toBe("completed");
    expect(result.decision?.mode).toBe("single");
    expect(result.mergedSlugs).toEqual(["main"]);
  });
});
