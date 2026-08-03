import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecAgentRunner } from "./dispatch.js";
import { finalizeRun, isGreenfield, runPipeline } from "./orchestrate.js";
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

  it("no remote: fast-forwards work onto base and reports it landed there", async () => {
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
    expect(result.pr?.reason).toMatch(/no remote/i);
    expect(result.landedOn).toBe("main");

    // With no remote, both lanes fast-forwarded onto base.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    // Cleanup ran: no orphan worktrees, and the (now-redundant) integration
    // branch was removed since its commits are on base.
    const { listWorktrees, branchExists } = await import("./worktree.js");
    const remaining = (await listWorktrees(repo)).filter((e) =>
      e.path.includes("pipe-1"),
    );
    expect(remaining).toHaveLength(0);
    expect(await branchExists(repo, "summon/pipe-1/integration")).toBe(false);
  });

  it("with a remote: keeps work on the integration branch and opens a PR (base clean)", async () => {
    const prVcs: Vcs = {
      async hasRemote() {
        return true;
      },
      async canOpenPr() {
        return true;
      },
      async openPr() {
        return { opened: true, url: "https://example/pr/7" };
      },
    };
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: prVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-pr", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("completed");
    expect(result.pr?.opened).toBe(true);
    expect(result.landedOn).toBe("summon/pipe-pr/integration");

    const { git, branchExists } = await import("./worktree.js");
    // Base stays clean; the work is on the retained integration branch.
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(await branchExists(repo, "summon/pipe-pr/integration")).toBe(true);
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

  it("out-of-lane backstop: flags an agent that edits outside its lane and does not merge", async () => {
    // The "auth" agent writes into src/api (the other lane) - a violation.
    const strayRunner = new ExecAgentRunner(({ subtask }) => ({
      command: process.execPath,
      args: [
        "-e",
        subtask.slug === "auth"
          ? `const fs=require("fs");fs.mkdirSync("src/api",{recursive:true});fs.writeFileSync("src/api/sneak.ts","x");fs.mkdirSync("src/auth",{recursive:true});fs.writeFileSync("src/auth/index.ts","x");`
          : `const fs=require("fs");fs.mkdirSync("src/api",{recursive:true});fs.writeFileSync("src/api/index.ts","x");`,
      ],
    }));

    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: strayRunner,
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-stray", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("needsHuman");
    expect(result.reason).toMatch(/out-of-lane/i);

    // Nothing merged onto base.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/api/sneak.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("no-op guard: agents that produce nothing report needsHuman, not completed", async () => {
    // Agents exit 0 but write no files (e.g. a sandboxed CLI that couldn't act).
    const noopRunner = new ExecAgentRunner(() => ({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    }));
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: noopRunner,
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-noop", watch: { intervalMs: 50 } },
    );
    expect(result.status).toBe("needsHuman");
    expect(result.reason).toMatch(/no file changes/i);

    // Base untouched - nothing landed.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
  });

  it("review gate: holds the merge on the integration branch, then finalizeRun lands it", async () => {
    const deps = {
      judge: splittingJudge(split2),
      runner: writingRunner(),
      vcs: noRemoteVcs,
      notifier: silentNotifier(),
    };
    const held = await runPipeline(repo, "Build auth and api", deps, {
      runId: "pipe-review",
      watch: { intervalMs: 50 },
      review: true,
    });

    // Held: merged+validated on the integration branch, base untouched, not final.
    expect(held.status).toBe("awaitingReview");
    expect(held.integrationBranch).toBe("summon/pipe-review/integration");
    const { git, branchExists } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false); // base is clean - nothing landed yet
    expect(await branchExists(repo, "summon/pipe-review/integration")).toBe(true);

    // Finalize on approval: no remote -> fast-forward base.
    const done = await finalizeRun(repo, "pipe-review", {
      vcs: noRemoteVcs,
      notifier: silentNotifier(),
    });
    expect(done.status).toBe("completed");
    expect(done.landedOn).toBe("main");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true); // now it landed
  });

  it("isGreenfield: true for an empty repo, false once a root manifest exists", async () => {
    expect(await isGreenfield(repo)).toBe(true);
    await fs.writeFile(path.join(repo, "package.json"), "{}\n");
    expect(await isGreenfield(repo)).toBe(false);
  });

  it("greenfield: prepends the greenfield note to the judge's triage plan", async () => {
    let seen = "";
    const capturingJudge: Judge = {
      async triage(plan) {
        seen = plan;
        return split2;
      },
      async resolveConflict() {
        return false;
      },
    };
    await runPipeline(
      repo, // makeTempRepo has no package.json -> greenfield
      "Build auth and api",
      {
        judge: capturingJudge,
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-green", watch: { intervalMs: 50 } },
    );
    expect(seen).toMatch(/greenfield/i);
    expect(seen).toContain("Build auth and api"); // original plan still there
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
