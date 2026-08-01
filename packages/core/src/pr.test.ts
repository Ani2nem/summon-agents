import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrResult, Vcs } from "./ports.js";
import { openPullRequest, preflight } from "./pr.js";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";
import { hasCommits, isGitRepo } from "./worktree.js";

describe("preflight (git/remote, local + reversible without asking)", () => {
  it("initializes a non-git dir and makes it branchable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summon-green-"));
    try {
      await fs.writeFile(path.join(dir, "index.js"), "console.log(1);\n");
      expect(await isGitRepo(dir)).toBe(false);

      const res = await preflight(dir);

      expect(res.initialized).toBe(true);
      expect(res.baselineCommitted).toBe(true);
      expect(await isGitRepo(dir)).toBe(true);
      expect(await hasCommits(dir)).toBe(true);
      expect(res.baseBranch.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempRepo(dir);
    }
  });

  it("is a no-op on an already-initialized repo with commits", async () => {
    const repo = await makeTempRepo();
    try {
      const res = await preflight(repo);
      expect(res.initialized).toBe(false);
      expect(res.baselineCommitted).toBe(false);
      expect(res.baseBranch).toBe("main");
    } finally {
      await cleanupTempRepo(repo);
    }
  });
});

describe("openPullRequest graceful degradation", () => {
  const base = {
    repoDir: "/repo",
    branch: "summon/r1/integration",
    baseBranch: "main",
    title: "t",
    body: "b",
  };

  function vcs(overrides: Partial<Vcs>): Vcs {
    return {
      async hasRemote() {
        return true;
      },
      async canOpenPr() {
        return true;
      },
      async openPr(): Promise<PrResult> {
        return { opened: true, url: "https://example/pr/1" };
      },
      ...overrides,
    };
  }

  it("returns a manual command when there is no remote", async () => {
    const res = await openPullRequest({
      ...base,
      vcs: vcs({ async hasRemote() {
        return false;
      } }),
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/no remote/i);
    expect(res.manualCommand).toContain("gh pr create");
  });

  it("returns a manual command when gh is unavailable/unauthenticated", async () => {
    const res = await openPullRequest({
      ...base,
      vcs: vcs({ async canOpenPr() {
        return false;
      } }),
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/gh/i);
    expect(res.manualCommand).toContain("git push");
  });

  it("delegates to vcs.openPr when remote + auth are present", async () => {
    const res = await openPullRequest({ ...base, vcs: vcs({}) });
    expect(res.opened).toBe(true);
    expect(res.url).toContain("example");
  });
});
