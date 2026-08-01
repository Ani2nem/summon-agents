// dispatch.ts - launch and supervise parallel agents. The riskiest mechanics.
//
// Each subtask runs in its own worktree, launched as a *detached* process so it
// survives the parent CLI exiting. We do NOT spawn the agent directly: we spawn
// a small trampoline that runs the agent and then writes result.json in a
// finally - guaranteeing a terminal record even if the agent crashes.
//
// Liveness is never "the PID exists" (a hung/rate-limited agent keeps a live PID
// forever). It is: result.json present (terminal, source of truth), OR a hard
// per-agent timeout, OR a no-progress watchdog (worktree/log mtime stalled).

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  type AgentRecord,
  AgentRecordSchema,
  type AgentResult,
  AgentResultSchema,
  type AgentRunner,
  type Notifier,
  type Subtask,
  type TriageDecision,
} from "./ports.js";
import { agentRunDir, runDir, worktreePathFor } from "./run.js";
import { addWorktree } from "./worktree.js";

// ---------------------------------------------------------------------------
// INSTRUCTIONS.md
// ---------------------------------------------------------------------------

/** The instruction file dropped into each worktree for its agent. */
export function renderInstructions(
  subtask: Subtask,
  hotspotFiles: readonly string[],
): string {
  const lanes =
    subtask.allowedFiles.length > 0
      ? subtask.allowedFiles.map((f) => `- ${f}`).join("\n")
      : "- (no strict allow-list; stay within the scope described above)";
  const hotspots =
    hotspotFiles.length > 0
      ? hotspotFiles.map((f) => `- ${f}`).join("\n")
      : "- (none)";
  return `# Task: ${subtask.title}

${subtask.instructions}

## Files you may modify (stay in your lane)

${lanes}

## Do NOT modify these shared files (handled centrally)

${hotspots}

## Rules

- Do only this task. Do not wander outside the files listed above.
- Do not fake progress, weaken tests, or edit files outside your lane to force a pass.
- If you cannot complete the task legitimately, stop and explain why instead.
- Commit your work in this worktree when done.
`;
}

// ---------------------------------------------------------------------------
// Trampoline: guarantees result.json on every exit
// ---------------------------------------------------------------------------

/**
 * Trampoline source, written next to each agent's run dir and launched detached.
 * Reads its config from SUMMON_TRAMPOLINE, runs the agent inheriting stdio (which
 * the parent pointed at log files), and always writes result.json.
 */
const TRAMPOLINE_SOURCE = `
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const cfg = JSON.parse(process.env.SUMMON_TRAMPOLINE);
const resultPath = path.join(cfg.runDir, "result.json");

function writeResult(status, exitCode) {
  let changedFiles = [];
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: cfg.worktreeDir, encoding: "utf8",
    });
    changedFiles = out.split("\\n").filter(Boolean).map((l) => l.slice(3));
  } catch {}
  writeFileSync(resultPath, JSON.stringify({
    slug: cfg.slug, status, exitCode,
    summary: "", changedFiles, endedAt: new Date().toISOString(),
  }, null, 2));
}

try {
  const child = spawn(cfg.command, cfg.args, { cwd: cfg.worktreeDir, stdio: "inherit" });
  child.on("error", (err) => { writeResult("error", null); process.exit(0); });
  child.on("exit", (code) => {
    writeResult(code === 0 ? "success" : "error", code);
    process.exit(0);
  });
} catch (err) {
  writeResult("error", null);
  process.exit(0);
}
`;

interface TrampolineConfig {
  command: string;
  args: string[];
  worktreeDir: string;
  runDir: string;
  slug: string;
}

/**
 * Spawn an agent detached under the trampoline. Returns the trampoline's pid.
 * stdio is redirected to files (never an unread pipe -> no deadlock). The child
 * is detached and unref'd so the parent can exit without killing it.
 */
export async function spawnDetachedAgent(cfg: TrampolineConfig): Promise<number> {
  await fs.mkdir(cfg.runDir, { recursive: true });
  const trampolinePath = path.join(cfg.runDir, "trampoline.mjs");
  await fs.writeFile(trampolinePath, TRAMPOLINE_SOURCE);

  const outFd = fsSync.openSync(path.join(cfg.runDir, "stdout.log"), "a");
  const errFd = fsSync.openSync(path.join(cfg.runDir, "stderr.log"), "a");
  try {
    const child = spawn(process.execPath, [trampolinePath], {
      cwd: cfg.worktreeDir,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: { ...process.env, SUMMON_TRAMPOLINE: JSON.stringify(cfg) },
    });
    child.unref();
    if (child.pid === undefined) throw new Error("failed to spawn agent");
    return child.pid;
  } finally {
    fsSync.closeSync(outFd);
    fsSync.closeSync(errFd);
  }
}

// ---------------------------------------------------------------------------
// AgentRunner: pluggable command builder (claude -p, cursor-agent, or a test stub)
// ---------------------------------------------------------------------------

export interface AgentCommand {
  command: string;
  args: string[];
}
export type CommandBuilder = (ctx: {
  subtask: Subtask;
  worktreeDir: string;
  runDir: string;
}) => AgentCommand;

/** Generic runner: builds a command per subtask and launches it detached. */
export class ExecAgentRunner implements AgentRunner {
  constructor(private readonly build: CommandBuilder) {}
  async launch(input: {
    subtask: Subtask;
    worktreeDir: string;
    runDir: string;
  }) {
    const { command, args } = this.build(input);
    const pid = await spawnDetachedAgent({
      command,
      args,
      worktreeDir: input.worktreeDir,
      runDir: input.runDir,
      slug: input.subtask.slug,
    });
    return { slug: input.subtask.slug, pid };
  }
}

// ---------------------------------------------------------------------------
// agents.json persistence
// ---------------------------------------------------------------------------

function agentsPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "agents.json");
}

export async function saveAgents(
  repoRoot: string,
  runId: string,
  records: AgentRecord[],
): Promise<void> {
  await fs.mkdir(runDir(repoRoot, runId), { recursive: true });
  await fs.writeFile(
    agentsPath(repoRoot, runId),
    JSON.stringify(records, null, 2),
  );
}

export async function loadAgents(
  repoRoot: string,
  runId: string,
): Promise<AgentRecord[]> {
  try {
    const raw = await fs.readFile(agentsPath(repoRoot, runId), "utf8");
    return AgentRecordSchema.array().parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Create a worktree per subtask, write its INSTRUCTIONS.md, launch its agent
 * detached, and record it to agents.json. Returns the launched agent records.
 */
export async function dispatchDecision(input: {
  repoRoot: string;
  runId: string;
  baseBranch: string;
  decision: TriageDecision;
  runner: AgentRunner;
  notifier?: Notifier;
}): Promise<AgentRecord[]> {
  const { repoRoot, runId, baseBranch, decision, runner, notifier } = input;
  const records: AgentRecord[] = [];

  for (const subtask of decision.subtasks) {
    const { branchNameFor } = await import("./run.js");
    const worktreeDir = worktreePathFor(repoRoot, runId, subtask.slug);
    const branch = branchNameFor(runId, subtask.slug);
    const rDir = agentRunDir(repoRoot, runId, subtask.slug);

    await addWorktree({ repoDir: repoRoot, worktreePath: worktreeDir, branch, baseBranch });
    await fs.mkdir(rDir, { recursive: true });
    // INSTRUCTIONS.md lives in the run dir, NOT the worktree: if it were in the
    // worktree it would be committed and collide across branches on merge.
    await fs.writeFile(
      path.join(rDir, "INSTRUCTIONS.md"),
      renderInstructions(subtask, decision.hotspotFiles),
    );

    const handle = await runner.launch({ subtask, worktreeDir, runDir: rDir });
    const record: AgentRecord = {
      slug: subtask.slug,
      pid: handle.pid,
      branch,
      worktree: worktreeDir,
      startedAt: new Date().toISOString(),
    };
    records.push(record);
    notifier?.info(`dispatched ${subtask.slug} (pid ${handle.pid})`);
  }

  await saveAgents(repoRoot, runId, records);
  return records;
}

// ---------------------------------------------------------------------------
// Supervision: await completion with timeout + no-progress watchdog
// ---------------------------------------------------------------------------

export interface WatchOptions {
  /** Hard per-agent timeout. Default 15 min. */
  timeoutMs?: number;
  /** No-progress (stalled mtime) threshold. Default 5 min. */
  noProgressMs?: number;
  /** Poll interval. Default 1s. */
  intervalMs?: number;
}

const DEFAULTS: Required<WatchOptions> = {
  timeoutMs: 15 * 60_000,
  noProgressMs: 5 * 60_000,
  intervalMs: 1_000,
};

function resultPathFor(repoRoot: string, runId: string, slug: string): string {
  return path.join(agentRunDir(repoRoot, runId, slug), "result.json");
}

async function readResult(
  repoRoot: string,
  runId: string,
  slug: string,
): Promise<AgentResult | null> {
  try {
    const raw = await fs.readFile(resultPathFor(repoRoot, runId, slug), "utf8");
    return AgentResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Newest mtime (ms) across the agent's log files and its worktree (2 levels). */
async function newestActivityMs(
  runDirPath: string,
  worktreeDir: string,
): Promise<number> {
  let newest = 0;
  const consider = async (p: string) => {
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {}
  };
  await consider(path.join(runDirPath, "stdout.log"));
  await consider(path.join(runDirPath, "stderr.log"));
  // Shallow scan of the worktree (skip .git / node_modules), two levels deep.
  const scan = async (dir: string, depth: number) => {
    if (depth < 0) return;
    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      await consider(full);
      if (e.isDirectory()) await scan(full, depth - 1);
    }
  };
  await scan(worktreeDir, 1);
  return newest;
}

/** Best-effort kill of the detached process group (trampoline + agent). */
function reapProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL"); // negative pid => process group
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function writeSyntheticResult(
  repoRoot: string,
  runId: string,
  slug: string,
  reason: string,
): Promise<AgentResult> {
  const result: AgentResult = {
    slug,
    status: "error",
    exitCode: null,
    summary: reason,
    changedFiles: [],
    endedAt: new Date().toISOString(),
  };
  await fs.mkdir(agentRunDir(repoRoot, runId, slug), { recursive: true });
  await fs.writeFile(
    resultPathFor(repoRoot, runId, slug),
    JSON.stringify(result, null, 2),
  );
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until every agent is terminal. An agent is terminal when it has written
 * result.json, or when it is reaped by the timeout or no-progress watchdog.
 * Returns the final result per slug. Push-style: notifier.agentDone fires as each
 * one lands.
 */
export async function awaitRun(input: {
  repoRoot: string;
  runId: string;
  records: AgentRecord[];
  notifier?: Notifier;
  options?: WatchOptions;
  /** Injectable clock for tests. */
  now?: () => number;
}): Promise<Map<string, AgentResult>> {
  const opts = { ...DEFAULTS, ...(input.options ?? {}) };
  const now = input.now ?? (() => Date.now());
  const results = new Map<string, AgentResult>();
  const lastProgress = new Map<string, number>();
  for (const r of input.records) {
    lastProgress.set(r.slug, Date.parse(r.startedAt));
  }

  while (results.size < input.records.length) {
    for (const record of input.records) {
      if (results.has(record.slug)) continue;

      const result = await readResult(input.repoRoot, input.runId, record.slug);
      if (result) {
        results.set(record.slug, result);
        input.notifier?.agentDone(result);
        continue;
      }

      const startedMs = Date.parse(record.startedAt);
      const rDir = agentRunDir(input.repoRoot, input.runId, record.slug);
      const activity = await newestActivityMs(rDir, record.worktree);
      if (activity > (lastProgress.get(record.slug) ?? startedMs)) {
        lastProgress.set(record.slug, activity);
      }

      const elapsed = now() - startedMs;
      const stalled = now() - (lastProgress.get(record.slug) ?? startedMs);

      if (elapsed > opts.timeoutMs) {
        reapProcess(record.pid);
        const synth = await writeSyntheticResult(
          input.repoRoot,
          input.runId,
          record.slug,
          `reaped: exceeded ${opts.timeoutMs}ms timeout`,
        );
        results.set(record.slug, synth);
        input.notifier?.agentDone(synth);
      } else if (stalled > opts.noProgressMs) {
        reapProcess(record.pid);
        const synth = await writeSyntheticResult(
          input.repoRoot,
          input.runId,
          record.slug,
          `reaped: no progress for ${opts.noProgressMs}ms`,
        );
        results.set(record.slug, synth);
        input.notifier?.agentDone(synth);
      }
    }
    if (results.size < input.records.length) await sleep(opts.intervalMs);
  }

  return results;
}
