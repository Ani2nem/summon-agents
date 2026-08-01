// orchestrate.ts - the full pipeline, reused by both the CLI and the MCP server.
//
// preflight -> lock (idempotency) -> triage/brake -> dispatch -> await (with
// watchdog) -> boss merge (+ validation gate) -> PR (graceful) -> report.
// Everything outward-facing or judgment-based is injected via ports so this same
// function runs under the CLI (claude Judge), MCP (host model Judge), and tests.

import { dispatchDecision, awaitRun, type WatchOptions } from "./dispatch.js";
import {
  commitAll,
  detectRunCommand,
  runMerge,
  type MergeTarget,
} from "./merge.js";
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
  newRunId,
  releaseLock,
  saveRun,
  setRunStatus,
} from "./run.js";
import { runTriage } from "./triage.js";

export interface PipelineResult {
  status: "skipped" | "completed" | "needsHuman";
  runId: string;
  reason: string;
  decision?: TriageDecision;
  mergedSlugs?: string[];
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
      await commitAll(repoRoot, "summon: pre-install shared dependencies");
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

    // PR (never merges remote; degrades to a manual command).
    const pr = await openPullRequest({
      repoDir: repoRoot,
      branch: merge.integrationBranch,
      baseBranch,
      title: firstLine(plan) || "summon-agents changes",
      body: prBody(decision),
      vcs,
    });

    const runCommand = await detectRunCommand(repoRoot);
    state = await setRunStatus({ repoRoot, state, status: "completed" });
    notifier.runDone(state, summarize(merge.mergedSlugs, pr, runCommand));

    return {
      status: "completed",
      runId,
      reason: "merged and validated",
      decision,
      mergedSlugs: merge.mergedSlugs,
      pr,
      runCommand,
      validationLabel: merge.validation.label,
    };
  } finally {
    await releaseLock(repoRoot);
  }
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
  merged: string[],
  pr: PrResult,
  runCommand: string | null,
): string {
  const parts = [`merged: ${merged.join(", ") || "(none)"}`];
  if (pr.opened) parts.push(`PR: ${pr.url}`);
  else if (pr.manualCommand) parts.push(`open a PR with: ${pr.manualCommand}`);
  if (runCommand) parts.push(`run it: ${runCommand}`);
  return parts.join(" | ");
}
