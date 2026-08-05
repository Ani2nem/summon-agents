import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAgents } from "./dispatch.js";
import { collectProgress, formatProgress, latestRunId } from "./progress.js";
import { agentRunDir, createRun } from "./run.js";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";
import { addWorktree } from "./worktree.js";

describe("collectProgress (read-only observability)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("reports a running agent with its touched files, then flips to done", async () => {
    const runId = "2026-01-01T00-00-00-000Z-test";
    const branch = `summon/${runId}/lane`;
    const wt = path.join(repo, ".summon-agents/worktrees", runId, "lane");
    await addWorktree({ repoDir: repo, worktreePath: wt, branch, baseBranch: "main" });
    await fs.writeFile(path.join(wt, "a.js"), "export const a = 1;\n");

    await createRun({ repoRoot: repo, plan: "p", baseBranch: "main", runId });
    await saveAgents(repo, runId, [
      {
        slug: "lane",
        pid: 999999,
        branch,
        worktree: wt,
        startedAt: new Date().toISOString(),
      },
    ]);

    // Running: no result.json yet, but the touched file shows up.
    let p = await collectProgress(repo, runId);
    expect(p).not.toBeNull();
    expect(p!.agents).toHaveLength(1);
    expect(p!.agents[0]!.state).toBe("running");
    expect(p!.agents[0]!.changedFiles).toContain("a.js");
    expect(formatProgress(p!)).toContain("lane");

    // Done: result.json present.
    const rDir = agentRunDir(repo, runId, "lane");
    await fs.mkdir(rDir, { recursive: true });
    await fs.writeFile(
      path.join(rDir, "result.json"),
      JSON.stringify({
        slug: "lane",
        status: "success",
        exitCode: 0,
        summary: "built it",
        changedFiles: ["a.js"],
        endedAt: new Date().toISOString(),
      }),
    );
    p = await collectProgress(repo, runId);
    expect(p!.agents[0]!.state).toBe("done");
    expect(p!.agents[0]!.summary).toBe("built it");

    expect(await latestRunId(repo)).toBe(runId);
  });

  it("returns null when there are no runs", async () => {
    expect(await collectProgress(repo)).toBeNull();
    expect(await latestRunId(repo)).toBeNull();
  });

  it("surfaces recent runs and formatProgress renders them", async () => {
    await createRun({ repoRoot: repo, plan: "p", baseBranch: "main", runId: "2026-01-01-old" });
    await createRun({ repoRoot: repo, plan: "p", baseBranch: "main", runId: "2026-01-02-new" });

    const p = await collectProgress(repo);
    expect(p).not.toBeNull();
    expect(p!.recentRuns).toBeDefined();
    // Newest-first, active run first.
    expect(p!.recentRuns!.map((r) => r.runId)).toEqual([
      "2026-01-02-new",
      "2026-01-01-old",
    ]);
    expect(p!.recentRuns![0]!.status).toBe("created");

    const out = formatProgress(p!);
    expect(out).toContain("recent runs:");
    expect(out).toContain("2026-01-02-new");
    expect(out).toContain("2026-01-01-old");
    expect(out).toContain("← active");
  });
});
