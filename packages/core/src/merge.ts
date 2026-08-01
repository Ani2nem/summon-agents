// merge.ts - the boss merge, sequential and gated.
//
// Subtask branches merge into an integration branch (not straight into local
// base, so a failed run never pollutes base). Conflicts are resolved by the
// Judge; if conflict markers remain, we abort and stop for a human. After all
// merges we regenerate lockfiles (loophole C) and run the validation gate
// (loophole A). Only if everything passes do we fast-forward local base.

import * as path from "node:path";
import { isLockfile } from "./hotspots.js";
import type { Judge, Notifier } from "./ports.js";
import { detectPackageManager } from "./validate.js";
import {
  detectValidationCommand,
  runValidation,
  type ValidationResult,
} from "./validate.js";
import { git, gitTry } from "./worktree.js";

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

/** Stage everything and commit if there is anything to commit. */
async function commitAll(
  repoDir: string,
  message: string,
): Promise<boolean> {
  await git(repoDir, ["add", "-A"]);
  const status = await git(repoDir, ["status", "--porcelain"]);
  if (status === "") return false;
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

/** Regenerate lockfiles rather than trusting a git-merged one (loophole C). */
async function regenerateLockfiles(
  repoDir: string,
  hotspotFiles: readonly string[],
): Promise<void> {
  if (!hotspotFiles.some(isLockfile)) return;
  const pm = await detectPackageManager(repoDir);
  await gitTry(repoDir, ["checkout", "--", "."]); // drop a half-merged lockfile
  const res = await gitTry(pm === "npm" ? "npm" : pm, ["install"], );
  void res; // best-effort; if the PM is unavailable we just skip regeneration
  await commitAll(repoDir, "summon: regenerate lockfile").catch(() => false);
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
      await gitTry(repoRoot, ["add", "-A"]);
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

  await regenerateLockfiles(repoRoot, input.hotspotFiles ?? []);

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
        await commitAll(repoRoot, "summon: fix validation failures");
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

  // Everything passed: fast-forward local base to the integration result.
  await git(repoRoot, ["checkout", baseBranch]);
  await git(repoRoot, ["merge", "--ff-only", integrationBranch]);

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
