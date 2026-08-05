// summon-agents CLI. What the editor hook invokes, and what you run by hand.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import {
  ExecAgentRunner,
  GhVcs,
  agentRunDir,
  attachArgs,
  collectProgress,
  findLatestRun,
  formatProgress,
  formatProgressLine,
  gc as gcCore,
  hasSession,
  isTerminal,
  latestRunId,
  loadAgents,
  loadRun,
  runIsActive,
  runPipeline,
  setRunStatus,
  type AgentRecord,
} from "@summon-agents/core";
import {
  agentAvailable,
  agentConfigFromEnv,
  agentCommandBuilder,
  agentJudge,
  parseSessionId,
  resolvePlan,
  resumeCommand,
} from "./claude.js";
import { stdoutNotifier } from "./notifier.js";

const program = new Command();

program
  .name("summon-agents")
  .description("Zero-setup orchestrator for parallel AI coding agents")
  .version("0.6.0");

program
  .command("run")
  .description("Run the pipeline for an approved plan")
  .option("-p, --plan <planOrFile>", "plan text or path to a plan file")
  .option("--vendor <vendor>", "worker agent vendor (claude|cursor|copilot|codex)")
  .option("--review", "hold the merge for your review; finalize with `summon-agents merge <runId>`")
  .option("--timeout <ms>", "hard per-agent timeout in ms")
  .action(async (opts) => {
    const repoRoot = process.cwd();
    const cfg = agentConfigFromEnv(
      opts.vendor
        ? { ...process.env, SUMMON_AGENT_VENDOR: opts.vendor }
        : process.env,
    );

    // Resolve the plan from --plan, or fail.
    let plan: string | null = null;
    if (opts.plan) {
      plan = await resolvePlan(opts.plan);
    } else {
      process.stderr.write("summon-agents: no plan (use --plan)\n");
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
        onTick: async () => {
          const p = await collectProgress(repoRoot);
          if (p) process.stdout.write(`  … ${formatProgressLine(p)}\n`);
        },
      },
    );

    printResult(result);
    process.exit(result.status === "needsHuman" ? 1 : 0);
  });

program
  .command("merge [runId]")
  .description("Finalize a run held by --review (defaults to the latest run awaiting review)")
  .action(async (runId: string | undefined) => {
    const repoRoot = process.cwd();
    let id = runId;
    if (!id) {
      const latest = await findLatestRun(
        repoRoot,
        (s) => s.status === "awaitingReview",
      );
      if (!latest) {
        process.stderr.write("summon-agents: no run awaiting review\n");
        process.exit(1);
      }
      id = latest.runId;
    }
    const { finalizeRun } = await import("@summon-agents/core");
    const result = await finalizeRun(repoRoot, id, {
      vcs: new GhVcs(),
      notifier: stdoutNotifier(),
    });
    printResult(result);
    process.exit(result.status === "needsHuman" ? 1 : 0);
  });

program
  .command("watch [runId]")
  .description("Open a live window into a run's agents (defaults to the latest run)")
  .option("--interval <ms>", "refresh interval", "1500")
  .action(async (runId: string | undefined, opts) => {
    const repoRoot = process.cwd();
    const interval = Math.max(500, Number(opts.interval) || 1500);
    const clear = () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    // Read-only: this just displays. The pipeline owns the watchdog/reaping; the
    // watcher never mutates the run, so it's safe to open and close anytime.
    for (;;) {
      const p = await collectProgress(repoRoot, runId);
      if (!p) {
        process.stdout.write("summon-agents: no runs found\n");
        return;
      }
      clear();
      process.stdout.write(formatProgress(p) + "\n");
      if (!runIsActive(p)) {
        process.stdout.write(`\n(run finished: ${p.status})\n`);
        return;
      }
      process.stdout.write(
        `\n… live · refreshing every ${interval}ms · Ctrl-C to close the window (agents keep cooking)\n`,
      );
      await new Promise((r) => setTimeout(r, interval));
    }
  });

program
  .command("status [runId]")
  .description("One-shot snapshot of a run's agents (defaults to the latest run)")
  .action(async (runId: string | undefined) => {
    const p = await collectProgress(process.cwd(), runId);
    process.stdout.write(
      (p ? formatProgress(p) : "summon-agents: no runs found") + "\n",
    );
  });

program
  .command("open [target]")
  .description(
    "Attach to a running agent's live session, or resume a finished agent's chat. " +
      "target is <slug> or <runId>/<slug> (defaults to the latest run's sole agent).",
  )
  .action(async (target: string | undefined) => {
    const repoRoot = process.cwd();
    const resolved = await resolveAgent(repoRoot, target);
    if ("error" in resolved) {
      process.stderr.write(`summon-agents: ${resolved.error}\n`);
      process.exit(1);
    }
    const { runId, record } = resolved;

    // 1) Live tmux session -> attach interactively.
    if (record.tmuxSession && (await hasSession(record.tmuxSession))) {
      process.stdout.write(
        `attaching to ${record.slug} (tmux ${record.tmuxSession}) - press Ctrl-b then d to detach (the agent keeps cooking)\n`,
      );
      const child = spawn("tmux", attachArgs(record.tmuxSession), {
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    // 2) Finished/failed -> try to resume its coding-agent session from the log.
    const cfg = agentConfigFromEnv();
    const logPath = path.join(agentRunDir(repoRoot, runId, record.slug), "stdout.log");
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    const sessionId = parseSessionId(cfg.vendor, log);
    if (sessionId) {
      const { command, args } = resumeCommand(cfg, sessionId);
      process.stdout.write(
        `resuming ${record.slug} (${cfg.vendor} session ${sessionId}) in ${record.worktree}\n`,
      );
      const child = spawn(command, args, {
        cwd: record.worktree,
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    // 3) Nothing to attach/resume - degrade gracefully with the manual path.
    process.stdout.write(
      `summon-agents: no live session and no recoverable ${cfg.vendor} session id for ${record.slug}.\n` +
        `  worktree: ${record.worktree}\n` +
        `  inspect/continue by hand: cd ${record.worktree} && ${cfg.bin}\n`,
    );
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
  .command("abort [runId]")
  .description("Abort a run (defaults to the latest active run; cleans up its worktrees and branches)")
  .action(async (runId: string | undefined) => {
    const repoRoot = process.cwd();
    let state = null;
    if (runId) {
      state = await loadRun(repoRoot, runId);
      if (!state) {
        process.stderr.write(`summon-agents: no such run ${runId}\n`);
        process.exit(1);
      }
    } else {
      state = await findLatestRun(repoRoot, (s) => !isTerminal(s.status));
      if (!state) {
        process.stderr.write("summon-agents: no active run\n");
        process.exit(1);
      }
    }
    await setRunStatus({ repoRoot, state, status: "aborted" });
    process.stdout.write(`summon-agents: aborted ${state.runId}\n`);
  });

program
  .command("init")
  .description("Install the /summon-agents trigger + MCP registration")
  .option("--host <host>", "claude-code | cursor | copilot | codex", "claude-code")
  .action(async (opts) => {
    const { runInit } = await import("./init.js");
    await runInit(process.cwd(), opts.host);
  });

/**
 * Resolve `open`'s target to a concrete (runId, agent record). `target` is a bare
 * slug (against the latest run), a `<runId>/<slug>` pair, or omitted (the latest
 * run, requiring it to have exactly one agent).
 */
async function resolveAgent(
  repoRoot: string,
  target: string | undefined,
): Promise<{ runId: string; record: AgentRecord } | { error: string }> {
  let runId: string | null;
  let slug: string | undefined;
  if (target && target.includes("/")) {
    const idx = target.indexOf("/");
    runId = target.slice(0, idx);
    slug = target.slice(idx + 1);
  } else {
    runId = await latestRunId(repoRoot);
    slug = target;
  }
  if (!runId) return { error: "no runs found" };

  const records = await loadAgents(repoRoot, runId);
  if (records.length === 0) return { error: `run ${runId} has no agents` };

  if (!slug) {
    if (records.length === 1) return { runId, record: records[0]! };
    return {
      error: `run ${runId} has ${records.length} agents; specify one: ${records
        .map((r) => r.slug)
        .join(", ")}`,
    };
  }
  const record = records.find((r) => r.slug === slug);
  if (!record)
    return {
      error: `no agent "${slug}" in run ${runId} (have: ${records
        .map((r) => r.slug)
        .join(", ")})`,
    };
  return { runId, record };
}

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
