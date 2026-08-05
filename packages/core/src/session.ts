// session.ts - tmux-backed detached sessions.
//
// tmux gives us a live, attachable pane for each agent: the user can `open` an
// agent and watch (or, once finished, resume) its coding-agent CLI. This is
// PURELY ADDITIVE - every helper shells out via execa with reject:false and
// degrades gracefully. When tmux is not installed, dispatch.ts falls back to the
// byte-for-byte detached-spawn path and none of this runs.
//
// tmux forbids `.` and `:` in session names (they are pane/window separators),
// so session names are sanitized. Panes combine stdout+stderr, so a single
// pipe-pane target file is enough to keep progress/mtime fresh.

import { execa } from "execa";

/**
 * True if a usable tmux is on PATH (`tmux -V` exits 0). Set SUMMON_DISABLE_TMUX=1
 * to force the detached-spawn fallback (used by the integration test suite so it
 * exercises the exact fallback path deterministically, without a tmux daemon).
 */
export async function tmuxAvailable(): Promise<boolean> {
  if (process.env.SUMMON_DISABLE_TMUX === "1") return false;
  const res = await execa("tmux", ["-V"], { reject: false });
  return res.exitCode === 0;
}

/** Replace every char not in [A-Za-z0-9_] with `_` (tmux forbids `.`/`:`). */
function san(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Deterministic tmux session name for a run's agent: summon_<runId>_<slug>. */
export function sessionName(runId: string, slug: string): string {
  return `summon_${san(runId)}_${san(slug)}`;
}

/** True if a tmux session by this name exists. */
export async function hasSession(name: string): Promise<boolean> {
  const res = await execa("tmux", ["has-session", "-t", name], {
    reject: false,
  });
  return res.exitCode === 0;
}

/**
 * Start a detached tmux session `name` in `cwd` running `command args`. Each env
 * var is passed with a `-e KEY=VALUE` flag (tmux 3.x). The command + args are the
 * remaining argv - execa array form, so NO shell interpolation happens.
 */
export async function newDetachedSession(input: {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<void> {
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(input.env ?? {})) {
    envFlags.push("-e", `${k}=${v}`);
  }
  await execa(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      input.name,
      "-c",
      input.cwd,
      ...envFlags,
      input.command,
      ...input.args,
    ],
    { reject: false },
  );
}

/**
 * Tee the pane's combined output to `file` (append). Keeps stdout.log fresh so
 * the existing progress/mtime watchdog works unchanged. `-o` toggles the pipe on
 * only if not already piping.
 */
export async function pipePaneToFile(name: string, file: string): Promise<void> {
  await execa(
    "tmux",
    ["pipe-pane", "-t", name, "-o", `cat >> ${JSON.stringify(file)}`],
    { reject: false },
  );
}

/** The last non-empty, trimmed line currently visible in the pane, if any. */
export async function capturePaneLastLine(
  name: string,
): Promise<string | undefined> {
  const res = await execa("tmux", ["capture-pane", "-p", "-t", name], {
    reject: false,
  });
  if (res.exitCode !== 0) return undefined;
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length ? lines[lines.length - 1] : undefined;
}

/** Kill a tmux session (best-effort; ignores "no such session"). */
export async function killSession(name: string): Promise<void> {
  await execa("tmux", ["kill-session", "-t", name], { reject: false });
}

/** All live tmux sessions whose name starts with `summon_`. */
export async function listSummonSessions(): Promise<string[]> {
  const res = await execa(
    "tmux",
    ["list-sessions", "-F", "#{session_name}"],
    { reject: false },
  );
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("summon_"));
}

/** Argv to attach to a session interactively: `tmux attach -t <name>`. */
export function attachArgs(name: string): string[] {
  return ["attach", "-t", name];
}
