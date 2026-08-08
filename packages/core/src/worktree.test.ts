import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempRepo, makeTempRepo } from "./testkit.js";
import {
  addWorktree,
  baselineCommit,
  branchExists,
  currentBranch,
  deleteBranch,
  git,
  hasCommits,
  initRepo,
  isGitRepo,
  listWorktrees,
  removeWorktree,
  workingTreeChanges,
} from "./worktree.js";

describe("worktree", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("detects a git repo and its baseline commit", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await hasCommits(repo)).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
  });

  it("workingTreeChanges splits tracked edits/deletions from untracked files", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "v1\n");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "add tracked"]);
    // clean tree
    expect((await workingTreeChanges(repo)).tracked).toEqual([]);

    // modify a tracked file + create a brand-new (untracked) one
    await fs.writeFile(path.join(repo, "tracked.txt"), "v2\n");
    await fs.writeFile(path.join(repo, "brand-new.txt"), "x\n");
    const changes = await workingTreeChanges(repo);
    expect(changes.tracked).toContain("tracked.txt");
    expect(changes.untracked).toContain("brand-new.txt");

    // a deletion of a tracked file counts as a tracked change (the dangerous kind)
    await fs.rm(path.join(repo, "tracked.txt"));
    expect((await workingTreeChanges(repo)).tracked).toContain("tracked.txt");
  });

  it("init + baselineCommit brings a greenfield dir to a branchable state", async () => {
    const green = await fs.mkdtemp(path.join(repo, "..", "green-"));
    try {
      expect(await isGitRepo(green)).toBe(false);
      await initRepo(green);
      // git config needed for commit in isolated env
      const { git } = await import("./worktree.js");
      await git(green, ["config", "user.email", "t@t.dev"]);
      await git(green, ["config", "user.name", "T"]);
      await fs.writeFile(path.join(green, "a.txt"), "hi");
      expect(await hasCommits(green)).toBe(false);
      const committed = await baselineCommit(green);
      expect(committed).toBe(true);
      expect(await hasCommits(green)).toBe(true);
    } finally {
      await cleanupTempRepo(green);
    }
  });

  it("adds, lists, and removes a worktree on a new branch", async () => {
    const wt = path.join(repo, ".summon-agents", "worktrees", "r1", "auth");
    await addWorktree({
      repoDir: repo,
      worktreePath: wt,
      branch: "summon/r1/auth",
      baseBranch: "main",
    });
    expect(await branchExists(repo, "summon/r1/auth")).toBe(true);

    const list = await listWorktrees(repo);
    const found = list.find((e) => e.branch === "summon/r1/auth");
    expect(found).toBeTruthy();

    await removeWorktree({ repoDir: repo, worktreePath: wt });
    await deleteBranch({ repoDir: repo, branch: "summon/r1/auth" });
    expect(await branchExists(repo, "summon/r1/auth")).toBe(false);
  });

  it("removeWorktree is a no-op on a missing path (safe during cleanup)", async () => {
    await expect(
      removeWorktree({
        repoDir: repo,
        worktreePath: path.join(repo, "does", "not", "exist"),
      }),
    ).resolves.toBeUndefined();
  });
});
