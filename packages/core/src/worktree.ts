// worktree.ts - deterministic git worktree/branch plumbing.
//
// We shell out to real `git` rather than a library: worktree support in JS git
// libraries is thin and inconsistent, whereas raw git is deterministic and its
// output is easy to parse. These wrappers are pure mechanics with no judgment.

import { execa } from "execa";

/** Run git in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}

/** Like `git`, but resolves the full result instead of throwing on failure. */
export async function gitTry(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const res = await execa("git", args, { cwd, reject: false });
  return {
    ok: res.exitCode === 0,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    exitCode: res.exitCode ?? -1,
  };
}

/** True if `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await gitTry(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout === "true";
}

/** True if the repo has at least one commit (a HEAD to branch from). */
export async function hasCommits(dir: string): Promise<boolean> {
  const res = await gitTry(dir, ["rev-parse", "--verify", "HEAD"]);
  return res.ok;
}

/** `git init` the directory (no commit). Idempotent. */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init"]);
}

/**
 * Stage everything and create a baseline commit. Worktrees need a commit to
 * branch from, so greenfield preflight calls this after init. Returns false if
 * there was nothing to commit.
 */
export async function baselineCommit(
  dir: string,
  message = "summon-agents: baseline commit",
): Promise<boolean> {
  await git(dir, ["add", "-A"]);
  const status = await git(dir, ["status", "--porcelain"]);
  if (status === "") return false;
  await git(dir, ["commit", "-m", message]);
  return true;
}

/** Name of the currently checked-out branch in `dir`. */
export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** True if `branch` exists locally. */
export async function branchExists(
  repoDir: string,
  branch: string,
): Promise<boolean> {
  const res = await gitTry(repoDir, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return res.ok;
}

/**
 * Create a worktree at `worktreePath` on a new branch `branch`, forked from
 * `baseBranch`. Deterministic; throws if the path or branch already exists.
 */
export async function addWorktree(input: {
  repoDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  const { repoDir, worktreePath, branch, baseBranch } = input;
  await git(repoDir, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseBranch,
  ]);
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
}

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const out = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) entries.push(normalizeEntry(cur));
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.branch = null;
    }
  }
  if (cur.path) entries.push(normalizeEntry(cur));
  return entries;
}

function normalizeEntry(cur: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: cur.path ?? "",
    branch: cur.branch ?? null,
    head: cur.head ?? null,
  };
}

/** Remove a worktree. `force` discards uncommitted changes in it. */
export async function removeWorktree(input: {
  repoDir: string;
  worktreePath: string;
  force?: boolean;
}): Promise<void> {
  const { repoDir, worktreePath, force = true } = input;
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  const res = await gitTry(repoDir, args);
  // A missing worktree is fine during cleanup; surface only unexpected errors.
  if (!res.ok && !/is not a working tree|No such file/i.test(res.stderr)) {
    throw new Error(`git worktree remove failed: ${res.stderr}`);
  }
}

/** Prune stale worktree administrative entries. */
export async function pruneWorktrees(repoDir: string): Promise<void> {
  await git(repoDir, ["worktree", "prune"]);
}

/** Delete a local branch. `force` uses -D. No-op if the branch is gone. */
export async function deleteBranch(input: {
  repoDir: string;
  branch: string;
  force?: boolean;
}): Promise<void> {
  const { repoDir, branch, force = true } = input;
  if (!(await branchExists(repoDir, branch))) return;
  await git(repoDir, ["branch", force ? "-D" : "-d", branch]);
}
