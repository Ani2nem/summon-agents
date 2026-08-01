// merge.ts - the boss merge, sequential and gated.
//
// Subtask branches merge into an integration branch (not straight into local
// base, so a failed run never pollutes base, and the integration branch is the
// reviewable deliverable). Conflicts are resolved by the Judge; if conflict
// markers remain, we abort and stop for a human. After all merges we regenerate
// existing lockfiles (loophole C) and run the validation gate (loophole A). On
// success the work stays on the integration branch; the caller decides whether
// to open a PR from it or fast-forward local base (when there is no remote).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LOCKFILE_BASENAMES } from "./hotspots.js";
import type { Judge, Notifier } from "./ports.js";
import { detectPackageManager } from "./validate.js";
import {
  detectValidationCommand,
  runValidation,
  type ValidationResult,
} from "./validate.js";
import { execa } from "execa";
import { git, gitTry } from "./worktree.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface MergeTarget {
  slug: string;
  branch: string;
  worktree: string;
}

export interface MergeOutcome {
  status: "merged" | "needsHuman";
  integrationBranch: string;
  baseBranch: string;
  reason: string;
  validation: ValidationResult;
  mergedSlugs: string[];
}

export function integrationBranchName(runId: string): string {
  return `summon/${runId}/integration`;
}

/**
 * Stage everything (including new files) and commit if anything changed. Use
 * ONLY in a clean worktree (agent work) - in the main repo it would sweep up
 * unrelated untracked files (e.g. the user's editor config).
 */
export async function commitAll(
  repoDir: string,
  message: string,
): Promise<boolean> {
  await git(repoDir, ["add", "-A"]);
  const status = await git(repoDir, ["status", "--porcelain"]);
  if (status === "") return false;
  await git(repoDir, ["commit", "-m", message]);
  return true;
}

/**
 * Stage only tracked modifications (`git add -u`) and commit. Safe to run in the
 * main repo: it never picks up stray untracked files. Used for judge-applied
 * fixes to already-tracked files during merge/validation.
 */
export async function commitTracked(
  repoDir: string,
  message: string,
): Promise<boolean> {
  await git(repoDir, ["add", "-u"]);
  const staged = await git(repoDir, ["diff", "--cached", "--name-only"]);
  if (staged === "") return false;
  await git(repoDir, ["commit", "-m", message]);
  return true;
}

/** Files git still considers unmerged (diff-filter=U). */
async function unmergedPaths(repoDir: string): Promise<string[]> {
  const res = await gitTry(repoDir, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  return res.stdout.split("\n").filter(Boolean);
}

/** True if any tracked file still contains conflict markers in the work tree. */
async function hasConflictMarkers(repoDir: string): Promise<boolean> {
  // git grep exits 0 when it finds matches, 1 when it does not.
  const res = await gitTry(repoDir, [
    "grep",
    "-lE",
    "^(<<<<<<<|>>>>>>>)",
  ]);
  return res.ok && res.stdout.trim().length > 0;
}

/**
 * Regenerate lockfiles rather than trusting a git-merged one (loophole C). Only
 * touches lockfiles that ALREADY exist in the repo (never creates one), and
 * stages only those lockfiles - so it can't sweep up unrelated untracked files
 * or leave a misleading "regenerate lockfile" commit that changed no lockfile.
 */
async function regenerateLockfiles(repoDir: string): Promise<void> {
  const existing: string[] = [];
  for (const lf of LOCKFILE_BASENAMES) {
    if (await fileExists(path.join(repoDir, lf))) existing.push(lf);
  }
  if (existing.length === 0) return; // repo uses no lockfile - nothing to do

  const pm = await detectPackageManager(repoDir);
  const install = await execa(pm, ["install"], { cwd: repoDir, reject: false });
  if (install.exitCode !== 0) return; // PM unavailable - skip regeneration

  for (const lf of existing) await gitTry(repoDir, ["add", lf]);
  const staged = await git(repoDir, ["diff", "--cached", "--name-only"]);
  if (staged !== "") {
    await git(repoDir, ["commit", "-m", "summon: regenerate lockfile"]);
  }
}

/**
 * Run the full boss merge. Returns "merged" (local base fast-forwarded, ready to
 * PR) or "needsHuman" (a gate failed; base untouched, integration branch left
 * for inspection).
 */
export async function runMerge(input: {
  repoRoot: string;
  runId: string;
  baseBranch: string;
  targets: MergeTarget[];
  judge: Judge;
  hotspotFiles?: readonly string[];
  notifier?: Notifier;
}): Promise<MergeOutcome> {
  const { repoRoot, runId, baseBranch, targets, judge, notifier } = input;
  const integrationBranch = integrationBranchName(runId);
  const mergedSlugs: string[] = [];
  const noValidation: ValidationResult = { ran: false, ok: true };

  // Fresh integration branch off base.
  await gitTry(repoRoot, ["branch", "-D", integrationBranch]);
  await git(repoRoot, ["checkout", "-b", integrationBranch, baseBranch]);

  for (const target of targets) {
    // Ensure the agent's work is committed on its branch before merging.
    await commitAll(target.worktree, `summon: ${target.slug} work`).catch(
      () => false,
    );

    const merge = await gitTry(repoRoot, [
      "merge",
      "--no-ff",
      "--no-edit",
      target.branch,
    ]);

    if (!merge.ok) {
      notifier?.info(`resolving conflict in ${target.slug}`);
      const resolved = await judge.resolveConflict({
        slug: target.slug,
        conflictedFiles: await unmergedPaths(repoRoot),
        repoDir: repoRoot,
      });
      // Stage only tracked (resolved) files; git already staged the merge's own
      // additions. Never `add -A` here - it would sweep unrelated untracked files.
      await gitTry(repoRoot, ["add", "-u"]);
      const markers = await hasConflictMarkers(repoRoot);
      if (!resolved || markers) {
        await gitTry(repoRoot, ["merge", "--abort"]);
        await gitTry(repoRoot, ["checkout", baseBranch]);
        return {
          status: "needsHuman",
          integrationBranch,
          baseBranch,
          reason: `unresolved conflict merging ${target.slug}`,
          validation: noValidation,
          mergedSlugs,
        };
      }
      await git(repoRoot, ["commit", "--no-edit"]);
    }
    mergedSlugs.push(target.slug);
  }

  await regenerateLockfiles(repoRoot);

  // Validation gate (loophole A).
  let validation = noValidation;
  const cmd = await detectValidationCommand(repoRoot);
  if (cmd) {
    validation = await runValidation(repoRoot, cmd);
    if (!validation.ok) {
      notifier?.info(`validation failed (${cmd.label}); asking judge to fix`);
      const fixed = await judge.resolveConflict({
        slug: "validation",
        conflictedFiles: [],
        repoDir: repoRoot,
        validationOutput: validation.output,
      });
      if (fixed) {
        await commitTracked(repoRoot, "summon: fix validation failures");
        validation = await runValidation(repoRoot, cmd);
      }
      if (!validation.ok) {
        await gitTry(repoRoot, ["checkout", baseBranch]);
        return {
          status: "needsHuman",
          integrationBranch,
          baseBranch,
          reason: `validation failed: ${cmd.label}`,
          validation,
          mergedSlugs,
        };
      }
    }
  }

  // Everything passed. The work stays on the integration branch (the reviewable
  // deliverable); return to base without fast-forwarding it. The caller opens a
  // PR from the integration branch, or fast-forwards base only when there is no
  // remote to PR against.
  await git(repoRoot, ["checkout", baseBranch]);

  return {
    status: "merged",
    integrationBranch,
    baseBranch,
    reason: "merged and validated",
    validation,
    mergedSlugs,
  };
}

/** Detect the run/test command to report to the user (best-effort). */
export async function detectRunCommand(
  repoRoot: string,
): Promise<string | null> {
  try {
    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        path.join(repoRoot, "package.json"),
        "utf8",
      ),
    );
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = await detectPackageManager(repoRoot);
    for (const name of ["dev", "start", "serve"]) {
      if (scripts[name]) return `${pm} run ${name}`;
    }
    if (scripts.test) return `${pm} test`;
  } catch {
    /* no package.json */
  }
  return null;
}
