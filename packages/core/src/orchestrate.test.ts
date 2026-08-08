import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecAgentRunner } from "./dispatch.js";
import {
  buildRecovery,
  finalizeRun,
  formatRecovery,
  isGreenfield,
  resolveAgent,
  runPipeline,
  shouldPreInstall,
} from "./orchestrate.js";
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

/** Vcs with no remote - work fast-forwards onto the local base branch. */
const noRemoteVcs: Vcs = {
  async hasRemote() {
    return false;
  },
  async pushBranch() {
    return { ok: false };
  },
  async remoteHasBranch() {
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
      async pushBranch() {
        return { ok: true };
      },
      async remoteHasBranch() {
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

  it("with a remote but no gh: pushes the integration branch, base stays clean", async () => {
    let pushed = "";
    const pushOnlyVcs: Vcs = {
      async hasRemote() {
        return true;
      },
      async pushBranch(_repo, branch) {
        pushed = branch;
        return { ok: true, hint: "https://gitlab.com/o/r/-/merge_requests/new" };
      },
      async remoteHasBranch() {
        return true; // established remote; base already exists
      },
      async canOpenPr() {
        return false; // no gh - the whole point of the push-first path
      },
      async openPr() {
        return { opened: false };
      },
    };
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: pushOnlyVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-push", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("completed");
    expect(result.pr?.opened).toBe(false);
    expect(pushed).toBe("summon/pipe-push/integration");
    expect(result.pr?.pushedBranch).toBe("summon/pipe-push/integration");
    expect(result.reason).toBe("merged and validated");
    expect(result.landedOn).toBe("summon/pipe-push/integration");

    // Base stays clean; the work is on the pushed integration branch.
    const { git, branchExists } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(await branchExists(repo, "summon/pipe-push/integration")).toBe(true);
  });

  it("fresh remote (nothing pushed yet): establishes the base branch, then pushes the work", async () => {
    const pushes: string[] = [];
    const freshRemoteVcs: Vcs = {
      async hasRemote() {
        return true;
      },
      async remoteHasBranch() {
        return false; // fresh remote - base branch not there yet
      },
      async pushBranch(_repo, branch) {
        pushes.push(branch);
        return { ok: true };
      },
      async canOpenPr() {
        return false;
      },
      async openPr() {
        return { opened: false };
      },
    };
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: freshRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-fresh", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("completed");
    // The base branch ("main") is pushed first to establish it, then the work.
    expect(pushes).toContain("main");
    expect(pushes).toContain("summon/pipe-fresh/integration");
    expect(pushes.indexOf("main")).toBeLessThan(
      pushes.indexOf("summon/pipe-fresh/integration"),
    );
    expect(result.pr?.pushedBranch).toBe("summon/pipe-fresh/integration");
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

    // Decision-point recovery: the clean lane (api) is parked, auth is contested.
    expect(result.recovery).toBeDefined();
    expect(result.recovery!.cleanSlugs).toEqual(["api"]);
    expect(result.recovery!.parkedBranch).toBe("summon/pipe-stray/parked");
    expect(result.recovery!.contested).toHaveLength(1);
    expect(result.recovery!.contested[0]!.file).toBe("src/api/sneak.ts");
    expect(result.recovery!.contested[0]!.slugs).toEqual(["auth"]);
    expect(result.recovery!.contested[0]!.convergent).toBe(false);
    expect(result.recovery!.options.some((o) => /open auth/.test(o))).toBe(true);

    // Nothing merged onto base.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/api/sneak.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    // The clean lane's work is preserved on the parked branch (not lost).
    await git(repo, ["checkout", "summon/pipe-stray/parked"]);
    expect(await exists(path.join(repo, "src/api/index.ts"))).toBe(true);
    expect(await exists(path.join(repo, "src/api/sneak.ts"))).toBe(false);
    await git(repo, ["checkout", "main"]);
  });

  it("decision-point: convergent drift (all agents make the same shared file) offers the shared-foundation option", async () => {
    // Both agents create their own root server.js - the "they all invented a
    // shared piece nobody owned" case.
    const convergentRunner = new ExecAgentRunner(({ subtask }) => ({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require("fs");fs.mkdirSync("src/${subtask.slug}",{recursive:true});fs.writeFileSync("src/${subtask.slug}/index.ts","x");fs.writeFileSync("server.js","// ${subtask.slug} server\\n");`,
      ],
    }));

    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: convergentRunner,
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-conv", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("needsHuman");
    expect(result.recovery).toBeDefined();
    // No lane stayed clean, so nothing to park.
    expect(result.recovery!.cleanSlugs).toEqual([]);
    expect(result.recovery!.parkedBranch).toBeNull();
    const serverFile = result.recovery!.contested.find(
      (c) => c.file === "server.js",
    );
    expect(serverFile).toBeDefined();
    expect(serverFile!.slugs.sort()).toEqual(["api", "auth"]);
    expect(serverFile!.convergent).toBe(true);
    // The headline option is to build it once as a shared foundation.
    expect(
      result.recovery!.options.some((o) => /shared foundation/i.test(o)),
    ).toBe(true);
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

  it("attended mode without tmux: returns needsHuman and does not dispatch or merge", async () => {
    // The vitest suite sets SUMMON_DISABLE_TMUX=1, so tmuxAvailable() is false.
    // Attended mode must bail early (base untouched) before any dispatch/merge.
    const result = await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-attended", watch: { intervalMs: 50 }, attended: true },
    );

    expect(result.status).toBe("needsHuman");
    expect(result.reason).toMatch(/tmux/i);
    // Nothing dispatched or merged: no decision was reached, base is untouched.
    expect(result.mergedSlugs).toBeUndefined();
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(
      await fs
        .access(path.join(repo, "src/auth/index.ts"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
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

  it("greenfield subdir lanes: files under a bare-directory lane merge (not out-of-lane)", async () => {
    // Reproduces the report: judge splits into bare "frontend"/"backend" lanes,
    // each agent scaffolds its own package.json + source inside its dir. Before
    // the matcher fix, frontend/package.json was flagged as out-of-lane.
    const bareLanes: TriageDecision = {
      mode: "split",
      reason: "frontend + backend",
      subtasks: [
        { slug: "frontend", title: "Frontend", instructions: "build frontend", allowedFiles: ["frontend"] },
        { slug: "backend", title: "Backend", instructions: "build backend", allowedFiles: ["backend"] },
      ],
      hotspotFiles: [],
      preInstall: [],
    };
    const scaffolder = new ExecAgentRunner(({ subtask }) => ({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require("fs");const d="${subtask.slug}";fs.mkdirSync(d+"/src",{recursive:true});fs.writeFileSync(d+"/package.json","{}\\n");fs.writeFileSync(d+"/package-lock.json","{}\\n");fs.writeFileSync(d+"/src/index.js","export const x=1;\\n");`,
      ],
    }));
    const result = await runPipeline(
      repo,
      "Build a React frontend and an Express backend",
      {
        judge: splittingJudge(bareLanes),
        runner: scaffolder,
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-bare", watch: { intervalMs: 50 } },
    );
    expect(result.reason).not.toMatch(/out-of-lane/i);
    expect(result.status).toBe("completed");

    // Both lanes' files landed on main.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    for (const p of ["frontend/package.json", "backend/package.json"]) {
      expect(
        await fs.access(path.join(repo, p)).then(() => true).catch(() => false),
      ).toBe(true);
    }
  });

  it("shouldPreInstall: only for a split on a non-greenfield repo", () => {
    const withDep = (over: Partial<TriageDecision>): TriageDecision => ({
      ...split2,
      preInstall: ["express"],
      ...over,
    });
    expect(shouldPreInstall(withDep({}), false)).toBe(true);
    expect(shouldPreInstall(withDep({}), true)).toBe(false); // greenfield
    expect(shouldPreInstall(withDep({ mode: "single" }), false)).toBe(false); // single
    expect(shouldPreInstall(withDep({ preInstall: [] }), false)).toBe(false); // nothing
  });

  it("greenfield single agent with preInstall: skips root install, merges cleanly", async () => {
    // Reproduces the merge-abort bug: a single-agent greenfield build whose
    // decision carries preInstall must NOT `npm install` at the root (that left
    // untracked manifests that blocked the merge). If the gate were wrong this
    // would try to hit npm; instead it runs the agent and completes.
    const single: TriageDecision = {
      mode: "single",
      reason: "greenfield, coupled",
      subtasks: [
        { slug: "app", title: "App", instructions: "build it", allowedFiles: [] },
      ],
      hotspotFiles: [],
      preInstall: ["express"],
    };
    const result = await runPipeline(
      repo, // makeTempRepo has no package.json -> greenfield
      "Build the app",
      {
        judge: splittingJudge(single),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-preinstall", watch: { intervalMs: 50 } },
    );
    expect(result.status).toBe("completed");
    expect(result.reason).not.toMatch(/preinstall|install/i);
  });

  it("resolve loop: a failed agent is fixed in place, then the whole run lands", async () => {
    // "api" succeeds. "auth" fails on its first run and succeeds on the retry
    // (gated by a marker in its run dir, which survives the lane teardown).
    const runner = new ExecAgentRunner(({ subtask, runDir }) => {
      if (subtask.slug === "api") {
        return {
          command: process.execPath,
          args: [
            "-e",
            `const fs=require("fs");fs.mkdirSync("src/api",{recursive:true});fs.writeFileSync("src/api/index.ts","export const api=1;\\n");`,
          ],
        };
      }
      const marker = path.join(runDir, "attempted");
      return {
        command: process.execPath,
        args: [
          "-e",
          `const fs=require("fs");const m=${JSON.stringify(marker)};` +
            `if(fs.existsSync(m)){fs.mkdirSync("src/auth",{recursive:true});fs.writeFileSync("src/auth/index.ts","export const auth=1;\\n");}` +
            `else{fs.writeFileSync(m,"1");process.exit(1);}`,
        ],
      };
    });
    const deps = {
      judge: splittingJudge(split2),
      runner,
      vcs: noRemoteVcs,
      notifier: silentNotifier(),
    };

    // First pass: auth fails -> decision-point (auth listed as failed, api parked).
    const first = await runPipeline(repo, "Build auth and api", deps, {
      runId: "pipe-resolve",
      watch: { intervalMs: 50 },
    });
    expect(first.status).toBe("needsHuman");
    expect(first.recovery).toBeDefined();
    expect(first.recovery!.failed.map((f) => f.slug)).toEqual(["auth"]);
    expect(first.recovery!.cleanSlugs).toEqual(["api"]);
    // The failed lane did NOT land; base is clean.
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    expect(await exists(path.join(repo, "src/auth/index.ts"))).toBe(false);

    // Resolve: re-run just auth with a fix -> it passes -> the whole run lands.
    const fixed = await resolveAgent({
      repoRoot: repo,
      slug: "auth",
      fix: "create src/auth/index.ts",
      runId: "pipe-resolve",
      deps,
      options: { watch: { intervalMs: 50 } },
    });
    expect(fixed.status).toBe("completed");
    await git(repo, ["checkout", "main"]);
    expect(await exists(path.join(repo, "src/auth/index.ts"))).toBe(true);
    expect(await exists(path.join(repo, "src/api/index.ts"))).toBe(true);
  });

  it("warns up front when the working tree has uncommitted tracked changes (agents won't see them)", async () => {
    const { commitFile } = await import("./testkit.js");
    await commitFile(repo, "readme.txt", "v1\n");
    // an uncommitted edit to a tracked file - invisible to worktrees forked from HEAD
    await fs.writeFile(path.join(repo, "readme.txt"), "v2 uncommitted\n");
    const msgs: string[] = [];
    const notifier: Notifier = {
      info: (m) => msgs.push(m),
      agentDone() {},
      runDone() {},
    };
    await runPipeline(
      repo,
      "Build auth and api",
      {
        judge: splittingJudge(split2),
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier,
      },
      { runId: "pipe-dirty", watch: { intervalMs: 50 } },
    );
    expect(
      msgs.some(
        (m) => /uncommitted change/i.test(m) && /HEAD/.test(m) && /readme\.txt/.test(m),
      ),
    ).toBe(true);
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

  it("split with integration: wires the shared file once, seeing every lane, and it lands on base", async () => {
    const split2WithIntegration: TriageDecision = {
      ...split2,
      integration: {
        title: "shared server",
        instructions: "add server.ts that serves the auth and api pieces",
      },
    };
    let sawBothLanes = false;
    // A splitting judge that also integrates: the integrator sees the merged
    // lanes and writes the one shared file none of them could build alone.
    const judge: Judge = {
      async triage() {
        return split2WithIntegration;
      },
      async resolveConflict() {
        return false;
      },
      async integrate(ctx) {
        sawBothLanes =
          (await exists(path.join(ctx.repoDir, "src/auth/index.ts"))) &&
          (await exists(path.join(ctx.repoDir, "src/api/index.ts")));
        await fs.writeFile(
          path.join(ctx.repoDir, "server.ts"),
          "// wires auth + api\n",
        );
        return true;
      },
    };

    const result = await runPipeline(
      repo,
      "Build auth and api served by one server",
      {
        judge,
        runner: writingRunner(),
        vcs: noRemoteVcs,
        notifier: silentNotifier(),
      },
      { runId: "pipe-intg", watch: { intervalMs: 50 } },
    );

    expect(result.status).toBe("completed");
    expect(sawBothLanes).toBe(true); // integration ran with all pieces present
    const { git } = await import("./worktree.js");
    await git(repo, ["checkout", "main"]);
    // Both lanes AND the wired shared server landed on base.
    expect(await exists(path.join(repo, "src/auth/index.ts"))).toBe(true);
    expect(await exists(path.join(repo, "src/api/index.ts"))).toBe(true);
    expect(await exists(path.join(repo, "server.ts"))).toBe(true);
  });
});

describe("buildRecovery / formatRecovery", () => {
  it("marks a file touched by 2+ agents as convergent and renders a readable block", () => {
    const r = buildRecovery(
      [
        { slug: "login", stray: ["server.js"] },
        { slug: "dash", stray: ["server.js"] },
        { slug: "solo", stray: ["config.toml"] },
      ],
      ["settings"],
      "summon/r/parked",
    );
    const server = r.contested.find((c) => c.file === "server.js")!;
    expect(server.convergent).toBe(true);
    expect(server.slugs).toEqual(["dash", "login"]);
    const config = r.contested.find((c) => c.file === "config.toml")!;
    expect(config.convergent).toBe(false);

    const textOut = formatRecovery(r);
    expect(textOut).toContain("summon/r/parked");
    expect(textOut).toContain("settings"); // the parked clean lane
    expect(textOut).toContain("server.js");
    expect(textOut.toLowerCase()).toContain("untouched"); // base reassurance
    expect(textOut.toLowerCase()).toContain("how to resolve");
  });

  it("handles nothing-parked (every lane contested)", () => {
    const r = buildRecovery([{ slug: "a", stray: ["x.js"] }], [], null);
    expect(r.parkedBranch).toBeNull();
    expect(formatRecovery(r).toLowerCase()).toContain(
      "no fully in-lane work to park",
    );
  });
});

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
