// progress.ts - read-only observability into a run's agents.
//
// Agents run headless (the kitchen cooks with the door closed), but the user can
// open the door anytime: collectProgress reads the on-disk run state - agents.json,
// each agent's result.json, and the live worktree - WITHOUT mutating anything (no
// reaping, no watchdog). The CLI `watch`/`status` commands and the summon_status
// MCP tool render it.

import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadAgents, newestActivityMs } from "./dispatch.js";
import { AgentResultSchema } from "./ports.js";
import { agentRunDir, loadRun, runsRoot } from "./run.js";
import { capturePaneLastLine, hasSession } from "./session.js";

export interface AgentProgress {
  slug: string;
  pid: number;
  state: "running" | "done" | "failed";
  elapsedMs: number;
  /** Time since this agent last touched a file / log (how "quiet" it is). */
  idleMs: number;
  /** Files the agent has created or modified in its worktree so far. */
  changedFiles: string[];
  summary?: string;
  /** Live "what it's doing right now": last pane line (tmux) or last log line. */
  currentActivity?: string;
}

export interface RunProgress {
  runId: string;
  status: string;
  agents: AgentProgress[];
  /** The most recent runs (newest-first), for at-a-glance context. */
  recentRuns?: { runId: string; status: string }[];
}

/** Most recent run id. Run ids are timestamp-prefixed, so sort order is chronological. */
export async function latestRunId(repoRoot: string): Promise<string | null> {
  try {
    const ids = (await fs.readdir(runsRoot(repoRoot))).sort();
    return ids.length ? ids[ids.length - 1]! : null;
  } catch {
    return null;
  }
}

/** Files an agent has touched in its worktree (excludes noise like node_modules). */
async function worktreeChangedFiles(worktree: string): Promise<string[]> {
  const res = await execa("git", ["status", "--porcelain"], {
    cwd: worktree,
    reject: false,
  });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter(
      (f) => !f.startsWith("node_modules/") && !f.startsWith(".summon-agents/"),
    );
}

/** Last non-empty line of a file, or undefined if empty/absent. */
async function lastLineOf(file: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A short "what it's doing right now" string: the live pane's last line when the
 * agent's tmux session is alive, else the last line of stdout.log (then
 * stderr.log). Read-only, best-effort.
 */
async function currentActivityFor(
  rDir: string,
  tmuxSession: string | undefined,
): Promise<string | undefined> {
  if (tmuxSession && (await hasSession(tmuxSession))) {
    const line = await capturePaneLastLine(tmuxSession);
    if (line) return line;
  }
  return (
    (await lastLineOf(path.join(rDir, "stdout.log"))) ??
    (await lastLineOf(path.join(rDir, "stderr.log")))
  );
}

/** Snapshot the live state of a run's agents. Read-only. */
export async function collectProgress(
  repoRoot: string,
  runId?: string,
): Promise<RunProgress | null> {
  const id = runId ?? (await latestRunId(repoRoot));
  if (!id) return null;
  const state = await loadRun(repoRoot, id);
  const records = await loadAgents(repoRoot, id);
  const now = Date.now();
  const recentRuns = await collectRecentRuns(repoRoot);

  const agents: AgentProgress[] = [];
  for (const r of records) {
    const rDir = agentRunDir(repoRoot, id, r.slug);
    let agentState: AgentProgress["state"] = "running";
    let summary: string | undefined;
    try {
      const raw = await fs.readFile(path.join(rDir, "result.json"), "utf8");
      const result = AgentResultSchema.parse(JSON.parse(raw));
      agentState = result.status === "success" ? "done" : "failed";
      summary = result.summary || undefined;
    } catch {
      /* no result yet - still running */
    }
    const changedFiles = await worktreeChangedFiles(r.worktree);
    const activity = await newestActivityMs(rDir, r.worktree);
    const startedMs = Date.parse(r.startedAt);
    const currentActivity = await currentActivityFor(rDir, r.tmuxSession);
    agents.push({
      slug: r.slug,
      pid: r.pid,
      state: agentState,
      elapsedMs: now - startedMs,
      idleMs: activity > 0 ? now - activity : now - startedMs,
      changedFiles,
      summary,
      currentActivity,
    });
  }
  return { runId: id, status: state?.status ?? "unknown", agents, recentRuns };
}

/** The ~5 most recent runs (newest-first) as {runId, status}, for at-a-glance context. */
async function collectRecentRuns(
  repoRoot: string,
): Promise<{ runId: string; status: string }[]> {
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(runsRoot(repoRoot))).sort();
  } catch {
    return [];
  }
  const recent = ids.slice(-5).reverse();
  const out: { runId: string; status: string }[] = [];
  for (const rid of recent) {
    const s = await loadRun(repoRoot, rid);
    out.push({ runId: rid, status: s?.status ?? "unknown" });
  }
  return out;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** Render a compact, human dashboard of a run's agents. */
export function formatProgress(p: RunProgress): string {
  const mark = (s: string) => (s === "done" ? "✓" : s === "failed" ? "✗" : "●");
  const lines: string[] = [];
  if (p.recentRuns && p.recentRuns.length > 0) {
    lines.push("recent runs:");
    for (const r of p.recentRuns) {
      const active = r.runId === p.runId ? " ← active" : "";
      lines.push(`  ${r.runId}  ·  ${r.status}${active}`);
    }
    lines.push("");
  }
  lines.push(`run ${p.runId}  ·  status: ${p.status}`);
  if (p.agents.length === 0) {
    lines.push("  (no agents yet - triaging / spinning up)");
    return lines.join("\n");
  }
  for (const a of p.agents) {
    lines.push("");
    const activity =
      a.state === "running" && a.currentActivity
        ? `  ·  "${a.currentActivity}"`
        : "";
    lines.push(
      `${mark(a.state)} ${a.slug}  ·  ${a.state}  ·  ${fmtDuration(
        a.elapsedMs,
      )} elapsed  ·  quiet ${fmtDuration(a.idleMs)}  ·  ${a.changedFiles.length} file(s)${activity}`,
    );
    if (a.summary) lines.push(`    ${a.summary}`);
    for (const f of a.changedFiles.slice(0, 8)) lines.push(`    ~ ${f}`);
    if (a.changedFiles.length > 8)
      lines.push(`    … +${a.changedFiles.length - 8} more`);
  }
  return lines.join("\n");
}

/** A single compact line for streaming into a chat / terminal heartbeat. */
export function formatProgressLine(p: RunProgress): string {
  if (p.agents.length === 0) return "triaging / spinning up…";
  const elapsed = Math.max(0, ...p.agents.map((a) => a.elapsedMs));
  const parts = p.agents.map(
    (a) =>
      `${a.slug} ${a.state === "running" ? `${a.changedFiles.length}f` : a.state}`,
  );
  return `cooking ${fmtDuration(elapsed)} · ${parts.join(" · ")}`;
}

/** True while a run is still working (so a live watcher keeps polling). */
export function runIsActive(p: RunProgress): boolean {
  if (p.status === "dispatched" || p.status === "merging") return true;
  return p.agents.some((a) => a.state === "running");
}
