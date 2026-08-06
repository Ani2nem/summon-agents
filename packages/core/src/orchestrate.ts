// orchestrate.ts - the full pipeline, reused by both the CLI and the MCP server.
//
// preflight -> lock (idempotency) -> triage/brake -> dispatch -> await (with
// watchdog) -> boss merge (+ validation gate) -> PR (graceful) -> report.
// Everything outward-facing or judgment-based is injected via ports so this same
// function runs under the CLI (claude Judge), MCP (host model Judge), and tests.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dispatchDecision, awaitRun, type WatchOptions } from "./dispatch.js";
import { outOfLaneFiles } from "./decompose.js";
import {
  commitAll,
  commitTracked,
  detectRunCommand,
  parkLanes,
  runMerge,
  type MergeTarget,
} from "./merge.js";
import { integrationBranchName } from "./merge.js";
import { landOnRemote, preflight } from "./pr.js";
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
import { tmuxAvailable } from "./session.js";
import { changedFilesVsBase, deleteBranch, git } from "./worktree.js";

/** Root project manifests. Their absence means the repo needs scaffolding. */
const ROOT_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
] as const;

/** True if the repo has no project manifest at its root - i.e. greenfield. */
export async function isGreenfield(repoRoot: string): Promise<boolean> {
  for (const m of ROOT_MANIFESTS) {
    try {
      await fs.access(path.join(repoRoot, m));
      return false;
    } catch {
      /* not present */
    }
  }
  return true;
}

/**
 * Whether to pre-install shared deps at the repo root before fan-out. ONLY for a
 * SPLIT on a non-greenfield repo (one that already has a root manifest). Running
 * it for a single agent is pointless - that agent installs its own deps in its
 * worktree - and on a greenfield repo `npm install` at the root creates untracked
 * package.json / lockfile / node_modules that then BLOCK the merge of the agent's
 * own committed manifest. That is the greenfield merge-abort bug.
 */
export function shouldPreInstall(
  decision: TriageDecision,
  greenfield: boolean,
): boolean {
  return (
    decision.preInstall.length > 0 && decision.mode === "split" && !greenfield
  );
}

/** Prepended to the triage plan (judge only) when the repo is greenfield. */
const GREENFIELD_TRIAGE_NOTE =
  "NOTE: The repository is currently EMPTY / greenfield (no project manifest at the root). Apply the GREENFIELD rules: split only into self-contained subdirectory lanes that each own their own manifest/config, or keep the whole plan as a single agent - never split shared repository-root setup across lanes.";

/** One file an agent changed outside its declared lane. */
export interface ContestedFile {
  /** The out-of-lane path. */
  file: string;
  /** The agents that touched it (sorted). */
  slugs: string[];
  /**
   * True when two or more agents each created/edited this same out-of-lane file -
   * a strong signal it is a shared foundation they all invented independently
   * (e.g. every page agent made its own root server.js). This is the case an
   * integration step is meant to own.
   */
  convergent: boolean;
}

/**
 * The empowered handoff for an out-of-lane stop. Rather than a terse dead-end,
 * this captures: what stayed clean (and where it was parked so it is not lost),
 * what is contested (and by whom), and plain-language next steps the human can
 * pick from - so a conflict is resolved as a DECISION, not by reading diffs. Base
 * is always untouched; the parked branch and the agent worktrees are preserved
 * for inspection (`summon-agents open <slug>`).
 */
export interface RecoveryPoint {
  /** Lanes that stayed in-lane; their work was parked, nothing lost. */
  cleanSlugs: string[];
  /** Branch holding the parked clean lanes (disjoint, merged), or null if none. */
  parkedBranch: string | null;
  /** Files edited outside a lane, and which agents touched each. */
  contested: ContestedFile[];
  /** Plain-language next steps for the human/chat to choose from. */
  options: string[];
}

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
  /**
   * Present on an out-of-lane needsHuman: the structured decision-point (parked
   * clean work + contested files + resolution options). Absent otherwise.
   */
  recovery?: RecoveryPoint;
}

/** Build the decision-point from the per-agent out-of-lane findings. */
export function buildRecovery(
  strayByRecord: { slug: string; stray: string[] }[],
  cleanSlugs: string[],
  parkedBranch: string | null,
): RecoveryPoint {
  const fileToSlugs = new Map<string, Set<string>>();
  for (const { slug, stray } of strayByRecord) {
    for (const f of stray) {
      const set = fileToSlugs.get(f) ?? new Set<string>();
      set.add(slug);
      fileToSlugs.set(f, set);
    }
  }
  const contested: ContestedFile[] = [...fileToSlugs.entries()]
    .map(([file, slugs]) => ({
      file,
      slugs: [...slugs].sort(),
      convergent: slugs.size >= 2,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const options: string[] = [];
  const convergent = contested.filter((c) => c.convergent);
  const solo = contested.filter((c) => !c.convergent);
  if (convergent.length > 0) {
    const files = convergent.map((c) => c.file).join(", ");
    options.push(
      `Build it ONCE as a shared foundation: re-summon and have a single integration step own ${files}, so it is created once for all lanes instead of each agent inventing its own.`,
    );
    options.push(
      `Drop it: re-summon telling the agents to keep their lanes self-contained and NOT create ${files}.`,
    );
  }
  for (const c of solo) {
    options.push(
      `${c.slugs[0]} edited ${c.file} outside its lane - re-summon with ${c.file} assigned to a single lane that owns it.`,
    );
  }
  const firstStray = strayByRecord[0]?.slug;
  if (firstStray) {
    options.push(
      `Look before deciding: summon-agents open ${firstStray} (inspect what an agent actually built).`,
    );
  }
  return { cleanSlugs: [...cleanSlugs].sort(), parkedBranch, contested, options };
}

/** Render a decision-point as a readable block for the CLI / MCP report. */
export function formatRecovery(r: RecoveryPoint): string {
  const lines: string[] = ["", "What happened:"];
  if (r.parkedBranch) {
    lines.push(
      `  clean work is safe - parked on branch ${r.parkedBranch}: ${r.cleanSlugs.join(", ")}`,
    );
  } else {
    lines.push("  no fully in-lane work to park");
  }
  if (r.contested.length > 0) {
    lines.push("  built outside any lane (not merged):");
    for (const c of r.contested) {
      const who = c.slugs.join(", ");
      const note = c.convergent
        ? ` (all of them made their own - a shared piece nobody owned)`
        : "";
      lines.push(`    ${c.file}  <-  ${who}${note}`);
    }
  }
  lines.push("  your base branch: untouched");
  if (r.options.length > 0) {
    lines.push("", "How to resolve (pick one, then re-summon):");
    for (const o of r.options) lines.push(`  - ${o}`);
  }
  return lines.join("\n");
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
  /**
   * Attended (interactive) mode. When true, each agent is launched INTERACTIVELY
   * in its tmux session; the human attaches with `summon-agents open <slug>`,
   * steers it, and exits it when done to let the pipeline continue to merge.
   * Requires tmux. The watchdog is relaxed so an agent idling while it waits for
   * the human is not reaped. Default false/undefined = unattended, unchanged.
   */
  attended?: boolean;
  /**
   * Periodic heartbeat during the cook phase (throttled), for live progress
   * streaming (e.g. MCP progress notifications, or a CLI heartbeat). Read-only.
   */
  onTick?: () => void | Promise<void>;
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

    // Attended (interactive) mode requires tmux: each agent runs in a tmux
    // session the human attaches to and drives. Without tmux there is nothing to
    // attach to, so bail early (base untouched) before any dispatch.
    if (options.attended && !(await tmuxAvailable())) {
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason:
          "attended mode requires tmux (not available). Install tmux or rerun without --attended.",
      };
    }

    // Triage + brake. On a greenfield repo, tell the judge so it splits into
    // self-contained subdirectory lanes instead of lanes that all scaffold at
    // the shared root (which collide and trip the out-of-lane backstop).
    const greenfield = await isGreenfield(repoRoot);
    if (greenfield) notifier.info("greenfield repo: steering split into per-lane subdirectories");
    const decision = await runTriage(
      judge,
      plan,
      repoRoot,
      greenfield ? GREENFIELD_TRIAGE_NOTE : undefined,
    );
    state = { ...state, decision };
    await saveRun(repoRoot, state);
    notifier.info(
      decision.mode === "split"
        ? `splitting into ${decision.subtasks.length} parallel agents`
        : `running a single agent: ${decision.reason}`,
    );

    // Pre-install shared deps once, up front, and commit them to base so every
    // lane forks from a state that already has them (loophole C). Gated: skipped
    // for a single agent (installs its own deps) and for greenfield (a root
    // install would leave untracked manifests that block the merge).
    if (shouldPreInstall(decision, greenfield)) {
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
    notifier.info(
      "live view while this runs: `npx -y summon-agents watch` (or `summon-agents status`) in this repo",
    );
    if (options.attended) {
      notifier.info(
        "attended mode: agents launched interactively - attach and drive each with `summon-agents open <slug>`; exit an agent when done to continue the merge.",
      );
    }

    // Attended agents idle while they wait for the human to attach and steer, so
    // relax the watchdog to effectively never reap on timeout / no-progress.
    // Merge over any explicit watch options so callers can still tune interval.
    const watch: WatchOptions | undefined = options.attended
      ? {
          ...options.watch,
          timeoutMs: 24 * 60 * 60 * 1000,
          noProgressMs: 24 * 60 * 60 * 1000,
        }
      : options.watch;

    const results = await awaitRun({
      repoRoot,
      runId,
      records,
      notifier,
      options: watch,
      onTick: options.onTick,
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
    const producedFiles = new Set<string>();
    const cleanTargets: MergeTarget[] = [];
    const strayByRecord: { slug: string; stray: string[] }[] = [];
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
      for (const f of changed) producedFiles.add(f);
      const stray = outOfLaneFiles(subtask, changed);
      if (stray.length > 0) {
        strayByRecord.push({ slug: record.slug, stray });
      } else {
        cleanTargets.push({
          slug: record.slug,
          branch: record.branch,
          worktree: record.worktree,
        });
      }
    }
    if (strayByRecord.length > 0) {
      // The empowered handoff: don't just dead-end. Park the clean, in-lane work
      // on a side branch (so nothing good is lost), then hand back a structured
      // decision-point - what's clean, what's contested, and how to resolve it -
      // instead of a bare "not merging". Base stays untouched; worktrees are
      // preserved (needsHuman never triggers cleanup) for `open <slug>`.
      const parkedBranch = await parkLanes({
        repoRoot,
        runId,
        baseBranch,
        targets: cleanTargets,
      });
      const recovery = buildRecovery(
        strayByRecord,
        cleanTargets.map((t) => t.slug),
        parkedBranch,
      );
      const violations = strayByRecord.map(
        (r) => `${r.slug} edited outside its lane: ${r.stray.join(", ")}`,
      );
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason: `out-of-lane edits detected; not merging: ${violations.join("; ")}`,
        decision,
        recovery,
      };
    }

    // No-op guard: every agent can exit 0 having produced nothing (e.g. a
    // sandboxed CLI that couldn't act, or one that just asked a question). A
    // clean merge of empty branches + a trivially-passing validation would
    // otherwise report "completed" on a run that changed nothing. Catch it.
    if (producedFiles.size === 0) {
      state = await setRunStatus({ repoRoot, state, status: "needsHuman" });
      return {
        status: "needsHuman",
        runId,
        reason:
          "agents produced no file changes - nothing to merge. The worker agent likely could not act; check .summon-agents/runs/" +
          `${runId}/<slug>/stdout.log for what each agent did.`,
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
      plan: state.plan,
      // Integration is a split-only step: a single agent already owns the whole
      // tree, so there is nothing separate to wire.
      integration: decision.mode === "split" ? decision.integration : null,
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

  // Decide where the work lands. If a remote exists, PUSH the integration branch
  // (plain git - no PR CLI required) and let the host offer a PR/MR; base stays
  // clean. Otherwise fast-forward local base onto the integration result and
  // report it as landed on the branch you were on.
  const hasRemote = await vcs.hasRemote(repoRoot);

  let pr: PrResult;
  let landedOn: string;
  if (hasRemote) {
    pr = await landOnRemote({
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
