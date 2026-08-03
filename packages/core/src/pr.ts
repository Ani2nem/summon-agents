// pr.ts - git/remote preflight and PR creation, degrading gracefully.
//
// Local, reversible actions happen silently (git init, baseline commit). Actions
// that reach a remote (push/PR) never happen automatically against main; we open
// a PR if we can, and otherwise hand the user the exact command. The remote
// merge button is never touched.

import { execa } from "execa";
import type { PrResult, Vcs } from "./ports.js";
import {
  baselineCommit,
  currentBranch,
  hasCommits,
  initRepo,
  isGitRepo,
} from "./worktree.js";

export interface PreflightResult {
  initialized: boolean;
  baselineCommitted: boolean;
  baseBranch: string;
}

/**
 * Ensure the repo is in a branchable state. Non-git dirs are initialized and get
 * a baseline commit; an empty repo gets a baseline commit. All local + reversible,
 * so no confirmation is needed. Returns the base branch to build on.
 */
export async function preflight(repoDir: string): Promise<PreflightResult> {
  let initialized = false;
  let baselineCommitted = false;

  if (!(await isGitRepo(repoDir))) {
    await initRepo(repoDir);
    initialized = true;
  }
  if (!(await hasCommits(repoDir))) {
    baselineCommitted = await baselineCommit(repoDir);
  }
  return {
    initialized,
    baselineCommitted,
    baseBranch: await currentBranch(repoDir),
  };
}

/** Vcs backed by `git` + the GitHub CLI (`gh`). */
export class GhVcs implements Vcs {
  async hasRemote(repoDir: string): Promise<boolean> {
    const res = await execa("git", ["remote"], { cwd: repoDir, reject: false });
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  async pushBranch(
    repoDir: string,
    branch: string,
  ): Promise<{ ok: boolean; hint?: string }> {
    const res = await execa("git", ["push", "-u", "origin", branch], {
      cwd: repoDir,
      reject: false,
    });
    if (res.exitCode !== 0) return { ok: false };
    // GitHub/GitLab print a "create a pull/merge request" URL on stderr when a
    // new branch is pushed. Surface it so the user has a one-click link even
    // without any PR CLI.
    const match = `${res.stderr}\n${res.stdout}`.match(/https?:\/\/\S+/);
    return { ok: true, hint: match?.[0] };
  }

  async remoteHasBranch(repoDir: string, branch: string): Promise<boolean> {
    const res = await execa(
      "git",
      ["ls-remote", "--heads", "origin", branch],
      { cwd: repoDir, reject: false },
    );
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  async canOpenPr(repoDir: string): Promise<boolean> {
    const which = await execa("gh", ["--version"], { reject: false });
    if (which.exitCode !== 0) return false;
    const auth = await execa("gh", ["auth", "status"], {
      cwd: repoDir,
      reject: false,
    });
    return auth.exitCode === 0;
  }

  // Assumes `branch` is already pushed (landOnRemote pushes first). Opens the PR
  // only - a convenience for GitHub users who have gh.
  async openPr(input: {
    repoDir: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PrResult> {
    const { repoDir, branch, baseBranch, title, body } = input;
    const pr = await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        baseBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repoDir, reject: false },
    );
    if (pr.exitCode !== 0) {
      return {
        opened: false,
        pushedBranch: branch,
        reason: `pushed ${branch}; gh pr create failed - open a PR/MR on your remote`,
        manualCommand: manualPrCommand(branch, baseBranch),
      };
    }
    return { opened: true, url: pr.stdout.trim(), pushedBranch: branch };
  }
}

export function manualPrCommand(branch: string, baseBranch: string): string {
  return `git push -u origin ${branch}  # then open a PR/MR (base: ${baseBranch}) on your remote`;
}

/**
 * Land the integration branch on the remote, degrading gracefully. The key move
 * is PUSH-FIRST with plain git (no PR CLI needed): any host - GitHub, GitLab,
 * Bitbucket - then offers to open a PR/MR for the pushed branch. If `gh` happens
 * to be installed we also open the PR for a direct link, but it is never
 * required. The remote merge button is never touched. Local base stays clean.
 */
export async function landOnRemote(input: {
  repoDir: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  vcs: Vcs;
}): Promise<PrResult> {
  const { repoDir, branch, baseBranch, vcs } = input;
  if (!(await vcs.hasRemote(repoDir))) {
    return {
      opened: false,
      reason: "no remote configured",
      manualCommand: manualPrCommand(branch, baseBranch),
    };
  }
  // Fresh remote (configured but nothing pushed yet): the PR base branch does not
  // exist on the remote, so establish it first - otherwise the pushed work branch
  // has no valid base to open a PR/MR against. Only push the base when it is
  // ABSENT; never clobber an existing (possibly shared) base branch.
  if (!(await vcs.remoteHasBranch(repoDir, baseBranch))) {
    await vcs.pushBranch(repoDir, baseBranch);
  }
  const pushed = await vcs.pushBranch(repoDir, branch);
  if (!pushed.ok) {
    return {
      opened: false,
      reason: "git push failed",
      manualCommand: manualPrCommand(branch, baseBranch),
    };
  }
  // Branch is on the remote. Open a PR via gh if available (nice link),
  // otherwise just report the pushed branch - the host offers PR/MR creation.
  if (await vcs.canOpenPr(repoDir)) {
    return vcs.openPr(input);
  }
  return {
    opened: false,
    pushedBranch: branch,
    reason: pushed.hint
      ? `pushed ${branch} to origin - open a PR/MR: ${pushed.hint}`
      : `pushed ${branch} to origin - open a PR/MR for it on your remote`,
  };
}
