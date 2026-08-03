import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrResult, Vcs } from "./ports.js";
import { landOnRemote, preflight } from "./pr.js";
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

describe("landOnRemote (push-first, gh optional)", () => {
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
      async pushBranch() {
        return { ok: true, hint: "https://github.com/o/r/pull/new/summon-r1" };
      },
      async canOpenPr() {
        return true;
      },
      async openPr(): Promise<PrResult> {
        return { opened: true, url: "https://example/pr/1", pushedBranch: base.branch };
      },
      ...overrides,
    };
  }

  it("returns a manual command when there is no remote", async () => {
    const res = await landOnRemote({
      ...base,
      vcs: vcs({ async hasRemote() {
        return false;
      } }),
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/no remote/i);
    expect(res.manualCommand).toContain("git push");
  });

  it("opens a PR when a remote + gh are present (after pushing the branch)", async () => {
    const res = await landOnRemote({ ...base, vcs: vcs({}) });
    expect(res.opened).toBe(true);
    expect(res.url).toContain("example");
  });

  it("without gh: pushes the branch and reports it, no PR CLI required", async () => {
    const res = await landOnRemote({
      ...base,
      vcs: vcs({ async canOpenPr() {
        return false;
      } }),
    });
    expect(res.opened).toBe(false);
    expect(res.pushedBranch).toBe(base.branch);
    expect(res.reason).toMatch(/pushed/i);
    expect(res.reason).toContain("pull/new"); // the host's create-PR hint URL
  });

  it("degrades to a manual command when the push itself fails", async () => {
    const res = await landOnRemote({
      ...base,
      vcs: vcs({ async pushBranch() {
        return { ok: false };
      } }),
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/push failed/i);
    expect(res.manualCommand).toContain("git push");
  });
});
