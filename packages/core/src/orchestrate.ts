// orchestrate.ts - the full pipeline, reused by both the CLI and the MCP server.
//
// preflight -> lock (idempotency) -> triage/brake -> dispatch -> await (with
// watchdog) -> boss merge (+ validation gate) -> PR (graceful) -> report.
// Everything outward-facing or judgment-based is injected via ports so this same
// function runs under the CLI (claude Judge), MCP (host model Judge), and tests.

import { dispatchDecision, awaitRun, type WatchOptions } from "./dispatch.js";
import { outOfLaneFiles } from "./decompose.js";
import {
  commitAll,
  commitTracked,
  detectRunCommand,
  runMerge,
  type MergeTarget,
} from "./merge.js";
import { integrationBranchName } from "./merge.js";
import { openPullRequest, preflight } from "./pr.js";
import { installDependencies } from "./validate.js";
import type {
  AgentRunner,
  Judge,
  Notifier,
  PrResult,
  TriageDecision,
  Vcs,
} from "./ports.js";
import {
  acquireLock,
  createRun,
  loadRun,
  newRunId,
  releaseLock,
  saveRun,
  setRunStatus,
} from "./run.js";
import { runTriage } from "./triage.js";
import { changedFilesVsBase, deleteBranch, git } from "./worktree.js";

export interface PipelineResult {
  status: "skipped" | "completed" | "needsHuman" | "awaitingReview";
  runId: string;
  reason: string;
  decision?: TriageDecision;
  mergedSlugs?: string[];
  /** Branch the work landed on: the integration branch (PR) or base (no remote). */
  landedOn?: string;
  /** The integration branch holding the merged+validated work (for review/finalize). */
  integrationBranch?: string;
  pr?: PrResult;
  runCommand?: string | null;
  validationLabel?: string;
}

export interface PipelineDeps {
  judge: Judge;
  runner: AgentRunner;
  vcs: Vcs;
  notifier: Notifier;
}

export interface PipelineOptions {
  runId?: string;
  watch?: WatchOptions;
  /**
   * Hold the merge for review (the --review / supervised gate). When true, the
   * pipeline merges + validates onto the integration branch but does NOT finalize
   * (no fast-forward to base, no PR). It returns "awaitingReview"; the caller
   * finalizes later via finalizeRun (summon_merge). Default false = auto-finalize,
   * identical to before.
   */
  review?: boolean;
}

/** Run the whole thing for an approved plan. Safe to call from a hook. */
export async function runPipeline(
  repoRoot: string,
  plan: string,
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { judge, runner, vcs, notifier } = deps;

  // Local + reversible preflight (no asking): init/baseline if needed.
  const pf = await preflight(repoRoot);
  if (pf.initialized) notifier.info("initialized a new git repository");
  if (pf.baselineCommitted) notifier.info("created a baseline commit");
  const baseBranch = pf.baseBranch;

  const runId = options.runId ?? newRunId();

  // Idempotency: if another run holds the lock, do nothing (loophole D).
  if (!(await acquireLock(repoRoot, runId))) {
    return {
      status: "skipped",
      runId,
      reason: "another summon-agents run is already active",
    };
  }

  try {
    let state = await createRun({ repoRoot, plan, baseBranch, runId });

    // Triage + brake.
    const decision = await runTriage(judge, plan, repoRoot);
    state = { ...state, decision };
    await saveRun(repoRoot, state);
    notifier.info(
      decision.mode === "split"
        ? `splitting into ${decision.subtasks.length} parallel agents`
        : `running a single agent: ${decision.reason}`,
    );

    // Pre-install shared deps once, up front, and commit them to base so every
    // lane forks from a state that already has them (loophole C).
    if (decision.preInstall.length > 0) {
      notifier.info(`installing shared deps: ${decision.preInstall.join(", ")}`);
      await installDependencies(repoRoot, decision.preInstall);
      await commitTracked(repoRoot, "summon: pre-install shared dependencies");
    }

    // Dispatch + supervise.
    const records = await dispatchDecision({
      repoRoot,
      runId,
      baseBranch,
      decision,
      runner,
      notifier,
    });
    state = await setRunStatus({ repoRoot, state, status: "dispatched" });

    const results = await awaitRun({
      repoRoot,
      runId,
      records,
      notifier,
      options: options.watch,
    });

    const failed = [...results.values()].filter((r) => r.status === "error");
    if (failed.length > 0) {
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason: `${failed.length} agent(s) did not finish cleanly: ${failed
          .map((f) => f.slug)
          .join(", ")}`,
        decision,
      };
    }

    // Out-of-lane backstop (loophole C): commit each agent's work, then verify it
    // only touched files in its declared lane. An agent that wandered outside its
    // lane - or clobbered a reserved manifest - is flagged before we merge.
    const bySlug = new Map(decision.subtasks.map((s) => [s.slug, s]));
    const violations: string[] = [];
    for (const record of records) {
      await commitAll(record.worktree, `summon: ${record.slug} work`).catch(
        () => false,
      );
      const subtask = bySlug.get(record.slug);
      if (!subtask) continue;
      const changed = await changedFilesVsBase(
        repoRoot,
        baseBranch,
        record.branch,
      );
      const stray = outOfLaneFiles(subtask, changed);
      if (stray.length > 0) {
        violations.push(`${record.slug} edited outside its lane: ${stray.join(", ")}`);
      }
    }
    if (violations.length > 0) {
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason: `out-of-lane edits detected; not merging: ${violations.join("; ")}`,
        decision,
      };
    }

    // Boss merge + validation gate.
    state = { ...state, status: "merging" };
    await saveRun(repoRoot, state);
    const targets: MergeTarget[] = records.map((r) => ({
      slug: r.slug,
      branch: r.branch,
      worktree: r.worktree,
    }));
    const merge = await runMerge({
      repoRoot,
      runId,
      baseBranch,
      targets,
      judge,
      hotspotFiles: decision.hotspotFiles,
      notifier,
    });

    if (merge.status === "needsHuman") {
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason: merge.reason,
        decision,
        mergedSlugs: merge.mergedSlugs,
        validationLabel: merge.validation.label,
      };
    }

    // The review gate: work is merged + validated on the integration branch, but
    // the user asked to approve before it lands. Stop here (base untouched, nothing
    // pushed) and hand off; the caller finalizes later via finalizeRun.
    if (options.review) {
      state = await setRunStatus({
        repoRoot,
        state,
        status: "awaitingReview",
      });
      notifier.info(
        `review gate: ${merge.mergedSlugs.length} task(s) merged + validated on ${merge.integrationBranch}. STOP and hand control to the human: show them the diff (git diff ${baseBranch}...${merge.integrationBranch}) and wait for THEIR explicit approval. Do NOT finalize on your own.`,
      );
      return {
        status: "awaitingReview",
        runId,
        reason:
          "HUMAN REVIEW REQUIRED. Merged + validated on the integration branch, but NOT finalized. Present the diff to the user and wait for the user's explicit go-ahead. Do NOT call summon_merge / finalize yourself - only after the human approves.",
        decision,
        mergedSlugs: merge.mergedSlugs,
        landedOn: merge.integrationBranch,
        integrationBranch: merge.integrationBranch,
        validationLabel: merge.validation.label,
      };
    }

    // Default: finalize immediately (auto-merge / PR), identical to before.
    const result = await finalizeRun(repoRoot, runId, { vcs, notifier });
    return { ...result, validationLabel: merge.validation.label };
  } finally {
    await releaseLock(repoRoot);
  }
}

/**
 * Finalize a run whose work is merged + validated on its integration branch:
 * open a PR (remote present) or fast-forward local base (no remote). Used both as
 * the default tail of runPipeline and, for the --review gate, called later on the
 * user's approval (summon_merge). Reloads everything from the run's state.
 */
export async function finalizeRun(
  repoRoot: string,
  runId: string,
  deps: { vcs: Vcs; notifier: Notifier },
): Promise<PipelineResult> {
  const { vcs, notifier } = deps;
  const state = await loadRun(repoRoot, runId);
  if (!state) {
    return { status: "needsHuman", runId, reason: `no such run: ${runId}` };
  }
  if (state.status === "completed") {
    return { status: "completed", runId, reason: "already finalized" };
  }
  const baseBranch = state.baseBranch;
  const decision = state.decision ?? undefined;
  const integrationBranch = integrationBranchName(runId);
  const mergedSlugs = decision?.subtasks.map((s) => s.slug) ?? [];

  // Decide where the work lands. If a remote + PR tooling exist, keep the work on
  // the integration branch and open a PR against base (base stays clean). Otherwise
  // fast-forward local base onto the integration result and report it as landed.
  const canPr = (await vcs.hasRemote(repoRoot)) && (await vcs.canOpenPr(repoRoot));

  let pr: PrResult;
  let landedOn: string;
  if (canPr) {
    pr = await openPullRequest({
      repoDir: repoRoot,
      branch: integrationBranch,
      baseBranch,
      title: firstLine(state.plan) || "summon-agents changes",
      body: decision ? prBody(decision) : "Automated by summon-agents.",
      vcs,
    });
    landedOn = integrationBranch;
  } else {
    await git(repoRoot, ["checkout", baseBranch]);
    await git(repoRoot, ["merge", "--ff-only", integrationBranch]);
    await deleteBranch({ repoDir: repoRoot, branch: integrationBranch });
    pr = {
      opened: false,
      reason: `no remote configured - work is merged locally onto ${baseBranch}`,
    };
    landedOn = baseBranch;
  }

  const runCommand = await detectRunCommand(repoRoot);
  const done = await setRunStatus({ repoRoot, state, status: "completed" });
  notifier.runDone(done, summarize(landedOn, pr, runCommand));

  return {
    status: "completed",
    runId,
    reason: "merged and validated",
    decision,
    mergedSlugs,
    landedOn,
    pr,
    runCommand,
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

function prBody(decision: TriageDecision): string {
  const lines = [
    "Automated by summon-agents.",
    "",
    `Mode: ${decision.mode}`,
    "",
    "Tasks:",
    ...decision.subtasks.map((s) => `- ${s.title}`),
  ];
  return lines.join("\n");
}

function summarize(
  landedOn: string,
  pr: PrResult,
  runCommand: string | null,
): string {
  const parts = [`work is on branch: ${landedOn}`];
  if (pr.opened) parts.push(`PR: ${pr.url}`);
  else if (pr.manualCommand) parts.push(`open a PR with: ${pr.manualCommand}`);
  else if (pr.reason) parts.push(pr.reason);
  if (runCommand) parts.push(`run it: ${runCommand}`);
  return parts.join(" | ");
}
