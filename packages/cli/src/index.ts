// summon-agents CLI. What the editor hook invokes, and what you run by hand.

import { Command } from "commander";
import {
  ExecAgentRunner,
  GhVcs,
  awaitRun,
  gc as gcCore,
  loadAgents,
  loadRun,
  runPipeline,
  setRunStatus,
} from "@summon-agents/core";
import {
  agentAvailable,
  agentConfigFromEnv,
  agentCommandBuilder,
  agentJudge,
  resolvePlan,
} from "./claude.js";
import { readHookPlan } from "./hook.js";
import { stdoutNotifier } from "./notifier.js";

const program = new Command();

program
  .name("summon-agents")
  .description("Zero-setup orchestrator for parallel AI coding agents")
  .version("0.2.2");

program
  .command("run")
  .description("Run the pipeline for an approved plan")
  .option("-p, --plan <planOrFile>", "plan text or path to a plan file")
  .option("--from-hook", "read the plan from an editor hook payload on stdin")
  .option("--host <host>", "hook host (claude-code|cursor|copilot)", "claude-code")
  .option("--vendor <vendor>", "worker agent vendor (claude|cursor|copilot)")
  .option("--yolo", "skip mid-task permission prompts (full autonomy)")
  .option("--review", "hold the merge for your review; finalize with `summon-agents merge <runId>`")
  .option("--timeout <ms>", "hard per-agent timeout in ms")
  .action(async (opts) => {
    const repoRoot = process.cwd();
    const cfg = agentConfigFromEnv(
      opts.vendor
        ? { ...process.env, SUMMON_AGENT_VENDOR: opts.vendor }
        : process.env,
    );
    if (opts.yolo) cfg.skipPermissions = true;

    // Resolve the plan: from a hook payload, from --plan, or fail.
    let plan: string | null = null;
    if (opts.fromHook) {
      plan = await readHookPlan(opts.host);
      if (plan === null) {
        // Not a finalized plan approval (e.g. propose stage, or wrong tool).
        // Exit 0 so we never wedge the editor (loophole D fail-soft).
        process.exit(0);
      }
    } else if (opts.plan) {
      plan = await resolvePlan(opts.plan);
    } else {
      process.stderr.write("summon-agents: no plan (use --plan or --from-hook)\n");
      process.exit(2);
    }

    if (!(await agentAvailable(cfg))) {
      process.stderr.write(
        `summon-agents: agent CLI "${cfg.bin}" not found on PATH. ` +
          `Set SUMMON_AGENT_BIN or install it.\n`,
      );
      process.exit(1);
    }

    const notifier = stdoutNotifier();
    const result = await runPipeline(
      repoRoot,
      plan,
      {
        judge: agentJudge(cfg),
        runner: new ExecAgentRunner(agentCommandBuilder(cfg)),
        vcs: new GhVcs(),
        notifier,
      },
      {
        watch: opts.timeout ? { timeoutMs: Number(opts.timeout) } : undefined,
        review: Boolean(opts.review),
      },
    );

    printResult(result);
    process.exit(result.status === "needsHuman" ? 1 : 0);
  });

program
  .command("merge <runId>")
  .description("Finalize a run held by --review (fast-forward base / open PR)")
  .action(async (runId: string) => {
    const repoRoot = process.cwd();
    const { finalizeRun } = await import("@summon-agents/core");
    const result = await finalizeRun(repoRoot, runId, {
      vcs: new GhVcs(),
      notifier: stdoutNotifier(),
    });
    printResult(result);
    process.exit(result.status === "needsHuman" ? 1 : 0);
  });

program
  .command("watch <runId>")
  .description("Watch an in-flight run until all agents finish")
  .action(async (runId: string) => {
    const repoRoot = process.cwd();
    const records = await loadAgents(repoRoot, runId);
    if (records.length === 0) {
      process.stderr.write(`summon-agents: no agents for run ${runId}\n`);
      process.exit(1);
    }
    await awaitRun({
      repoRoot,
      runId,
      records,
      notifier: stdoutNotifier(),
    });
  });

program
  .command("gc")
  .alias("doctor")
  .description("Reap orphan worktrees/branches from dead runs")
  .action(async () => {
    const repoRoot = process.cwd();
    const reaped = await gcCore(repoRoot);
    process.stdout.write(
      `summon-agents: reaped ${reaped.worktreesRemoved.length} worktree(s), ` +
        `${reaped.branchesDeleted.length} branch(es)\n`,
    );
  });

program
  .command("abort <runId>")
  .description("Abort a run (cleans up its worktrees and branches)")
  .action(async (runId: string) => {
    const repoRoot = process.cwd();
    const state = await loadRun(repoRoot, runId);
    if (!state) {
      process.stderr.write(`summon-agents: no such run ${runId}\n`);
      process.exit(1);
    }
    await setRunStatus({ repoRoot, state, status: "aborted" });
    process.stdout.write(`summon-agents: aborted ${runId}\n`);
  });

program
  .command("init")
  .description("Install the /summon-agents trigger + MCP registration")
  .option("--host <host>", "claude-code | cursor | copilot", "claude-code")
  .action(async (opts) => {
    const { runInit } = await import("./init.js");
    await runInit(process.cwd(), opts.host);
  });

function printResult(result: Awaited<ReturnType<typeof runPipeline>>): void {
  const out = process.stdout;
  if (result.status === "skipped") {
    out.write(`summon-agents: skipped (${result.reason})\n`);
    return;
  }
  if (result.status === "needsHuman") {
    out.write(`summon-agents: needs a human - ${result.reason}\n`);
    return;
  }
  if (result.status === "awaitingReview") {
    out.write(`summon-agents: awaiting review - run ${result.runId}\n`);
    out.write(`  merged: ${result.mergedSlugs?.join(", ") || "(none)"}\n`);
    if (result.integrationBranch)
      out.write(`  review: git diff main...${result.integrationBranch}\n`);
    if (result.validationLabel) out.write(`  validated: ${result.validationLabel}\n`);
    out.write(`  finalize: summon-agents merge ${result.runId}\n`);
    return;
  }
  out.write(`summon-agents: completed run ${result.runId}\n`);
  out.write(`  merged: ${result.mergedSlugs?.join(", ") || "(none)"}\n`);
  if (result.landedOn) out.write(`  work is on branch: ${result.landedOn}\n`);
  if (result.validationLabel) out.write(`  validated: ${result.validationLabel}\n`);
  if (result.pr?.opened) out.write(`  PR: ${result.pr.url}\n`);
  else if (result.pr?.manualCommand)
    out.write(`  open a PR: ${result.pr.manualCommand}\n`);
  else if (result.pr?.reason) out.write(`  ${result.pr.reason}\n`);
  if (result.runCommand) out.write(`  run it: ${result.runCommand}\n`);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`summon-agents: ${(err as Error).message}\n`);
  process.exit(1);
});
