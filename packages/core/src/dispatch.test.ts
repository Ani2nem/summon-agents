import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecAgentRunner,
  awaitRun,
  dispatchDecision,
  loadAgents,
  renderInstructions,
} from "./dispatch.js";
import type { TriageDecision } from "./ports.js";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";

function decision(
  slugs: string[],
  mode: "split" | "single" = "split",
): TriageDecision {
  return {
    mode,
    reason: "test",
    subtasks: slugs.map((slug) => ({
      slug,
      title: slug,
      instructions: `implement ${slug}`,
      allowedFiles: [`src/${slug}/**`],
    })),
    hotspotFiles: ["package.json"],
    preInstall: [],
  };
}

/** A runner whose agents each run a short node one-liner. */
function nodeRunner(script: (slug: string) => string) {
  return new ExecAgentRunner(({ subtask }) => ({
    command: process.execPath,
    args: ["-e", script(subtask.slug)],
  }));
}

describe("renderInstructions", () => {
  it("includes the lane allow-list and the do-not-touch hotspots", () => {
    const md = renderInstructions(
      {
        slug: "auth",
        title: "Auth",
        instructions: "build login",
        allowedFiles: ["src/auth/**"],
      },
      ["package.json"],
    );
    expect(md).toMatch(/build login/);
    expect(md).toMatch(/src\/auth\/\*\*/);
    expect(md).toMatch(/package\.json/);
    expect(md).toMatch(/Do not fake progress/i);
  });
});

describe("dispatch + awaitRun", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("happy path: creates worktrees, writes instructions, agents succeed", async () => {
    const runId = "run-ok";
    // Each agent writes a file into its worktree, then exits 0.
    const runner = nodeRunner(
      (slug) =>
        `require("fs").writeFileSync("done-${slug}.txt","ok"); process.exit(0);`,
    );
    const records = await dispatchDecision({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      decision: decision(["auth", "api"]),
      runner,
    });
    expect(records).toHaveLength(2);

    // INSTRUCTIONS.md exists in each worktree.
    for (const r of records) {
      const md = await fs.readFile(
        path.join(r.worktree, "INSTRUCTIONS.md"),
        "utf8",
      );
      expect(md).toContain("Task:");
    }
    // agents.json persisted.
    const loaded = await loadAgents(repo, runId);
    expect(loaded.map((r) => r.slug).sort()).toEqual(["api", "auth"]);

    const results = await awaitRun({
      repoRoot: repo,
      runId,
      records,
      options: { intervalMs: 50 },
    });
    expect(results.get("auth")!.status).toBe("success");
    expect(results.get("api")!.status).toBe("success");
    // The trampoline captured the file the agent created.
    expect(results.get("auth")!.changedFiles).toContain("done-auth.txt");
  });

  it("crash without result: trampoline still records an error", async () => {
    const runId = "run-crash";
    const runner = nodeRunner(() => `process.exit(3);`);
    const records = await dispatchDecision({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      decision: decision(["boom"], "single"),
      runner,
    });
    const results = await awaitRun({
      repoRoot: repo,
      runId,
      records,
      options: { intervalMs: 50 },
    });
    expect(results.get("boom")!.status).toBe("error");
    expect(results.get("boom")!.exitCode).toBe(3);
  });

  it("watchdog: reaps an agent that exceeds the hard timeout", async () => {
    const runId = "run-timeout";
    // Hang forever without writing result.json.
    const runner = nodeRunner(() => `setInterval(() => {}, 1000);`);
    const records = await dispatchDecision({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      decision: decision(["hang"], "single"),
      runner,
    });
    const results = await awaitRun({
      repoRoot: repo,
      runId,
      records,
      options: { intervalMs: 50, timeoutMs: 300, noProgressMs: 10_000 },
    });
    expect(results.get("hang")!.status).toBe("error");
    expect(results.get("hang")!.summary).toMatch(/timeout/i);
  });

  it("watchdog: reaps an agent that makes no progress", async () => {
    const runId = "run-stall";
    const runner = nodeRunner(() => `setInterval(() => {}, 1000);`);
    const records = await dispatchDecision({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      decision: decision(["stall"], "single"),
      runner,
    });
    const results = await awaitRun({
      repoRoot: repo,
      runId,
      records,
      options: { intervalMs: 50, timeoutMs: 10_000, noProgressMs: 300 },
    });
    expect(results.get("stall")!.status).toBe("error");
    expect(results.get("stall")!.summary).toMatch(/no progress/i);
  });
});
