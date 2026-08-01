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

  async canOpenPr(repoDir: string): Promise<boolean> {
    const which = await execa("gh", ["--version"], { reject: false });
    if (which.exitCode !== 0) return false;
    const auth = await execa("gh", ["auth", "status"], {
      cwd: repoDir,
      reject: false,
    });
    return auth.exitCode === 0;
  }

  async openPr(input: {
    repoDir: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PrResult> {
    const { repoDir, branch, baseBranch, title, body } = input;
    const push = await execa(
      "git",
      ["push", "-u", "origin", branch],
      { cwd: repoDir, reject: false },
    );
    if (push.exitCode !== 0) {
      return {
        opened: false,
        reason: "git push failed",
        manualCommand: manualPrCommand(branch, baseBranch),
      };
    }
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
        reason: "gh pr create failed",
        manualCommand: manualPrCommand(branch, baseBranch),
      };
    }
    return { opened: true, url: pr.stdout.trim() };
  }
}

export function manualPrCommand(branch: string, baseBranch: string): string {
  return `git push -u origin ${branch} && gh pr create --base ${baseBranch} --head ${branch}`;
}

/**
 * Open a PR for the integration branch, degrading gracefully: if there is no
 * remote or no PR tooling/auth, return the exact manual command instead of
 * failing. Local work already succeeded before this is called.
 */
export async function openPullRequest(input: {
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
  if (!(await vcs.canOpenPr(repoDir))) {
    return {
      opened: false,
      reason: "gh not installed or not authenticated",
      manualCommand: manualPrCommand(branch, baseBranch),
    };
  }
  return vcs.openPr(input);
}
