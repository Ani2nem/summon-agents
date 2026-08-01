// triage.ts - the deterministic wrapper around the Judge's split decision.
//
// The Judge (an LLM) decides *how* to split; this module makes the result safe
// and deterministic: reserve hotspots out of the lanes (loophole C), enforce the
// brake (coerce to a single agent when the work is not cleanly splittable), and
// fall back to single-agent on any judge failure rather than forking blindly.

import { detectHotspots, isHotspot } from "./hotspots.js";
import { laneOverlaps } from "./decompose.js";
import {
  type Judge,
  type Subtask,
  type TriageDecision,
  TriageDecisionSchema,
} from "./ports.js";

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Canonical single-agent decision - the safe default the brake falls back to. */
export function singleDecision(plan: string, reason: string): TriageDecision {
  return {
    mode: "single",
    reason,
    subtasks: [
      {
        slug: "main",
        title: "Implement the approved plan",
        instructions: plan,
        allowedFiles: [],
      },
    ],
    hotspotFiles: [],
    preInstall: [],
  };
}

/** Make slugs unique by suffixing duplicates (-2, -3, ...). */
export function dedupeSlugs(subtasks: Subtask[]): Subtask[] {
  const seen = new Map<string, number>();
  return subtasks.map((s) => {
    const n = seen.get(s.slug) ?? 0;
    seen.set(s.slug, n + 1);
    return n === 0 ? s : { ...s, slug: `${s.slug}-${n + 1}` };
  });
}

/**
 * Reserve hotspot files out of the parallel lanes: strip any hotspot entries
 * from each subtask's allow-list and collect them into decision.hotspotFiles
 * (union of pattern-detected and Judge-declared hotspots).
 */
export function reserveHotspots(decision: TriageDecision): TriageDecision {
  const allFiles = decision.subtasks.flatMap((s) => s.allowedFiles);
  const explicit = decision.hotspotFiles.map(normalize);
  const detected = detectHotspots(allFiles);
  const hotspotSet = new Set<string>([...explicit, ...detected]);

  const subtasks = decision.subtasks.map((s) => ({
    ...s,
    allowedFiles: s.allowedFiles.filter(
      (f) => !isHotspot(f) && !hotspotSet.has(normalize(f)),
    ),
  }));

  return {
    ...decision,
    subtasks,
    hotspotFiles: [...hotspotSet].sort(),
  };
}

/**
 * Normalize + apply the brake. Returns a decision that is safe to act on:
 *  - single mode is coerced to exactly one subtask (running the whole plan);
 *  - hotspots are reserved out of the lanes;
 *  - if genuine (post-reservation) lane overlaps remain, coerce to single.
 */
export function normalizeDecision(
  raw: TriageDecision,
  plan: string,
): TriageDecision {
  const parsed = TriageDecisionSchema.parse(raw);
  const subtasks = dedupeSlugs(parsed.subtasks);

  // The brake: not enough to split, or explicitly single => one agent.
  if (parsed.mode === "single" || subtasks.length <= 1) {
    if (subtasks.length === 1) {
      return { ...parsed, mode: "single", subtasks };
    }
    return singleDecision(plan, parsed.reason || "not worth splitting");
  }

  const reserved = reserveHotspots({ ...parsed, subtasks });

  const overlaps = laneOverlaps(reserved.subtasks);
  if (overlaps.length > 0) {
    const files = [...new Set(overlaps.flatMap((o) => o.files))];
    return singleDecision(
      plan,
      `coerced to single agent: lanes overlap on ${files.join(", ")}`,
    );
  }

  return reserved;
}

/**
 * Run the full triage: ask the Judge, then normalize + brake. Any failure
 * (judge error or invalid decision) falls back to a single agent - the tool
 * never forks worktrees off a decision it could not validate.
 */
export async function runTriage(
  judge: Judge,
  plan: string,
  repoDir: string,
): Promise<TriageDecision> {
  let raw: TriageDecision;
  try {
    raw = await judge.triage(plan, repoDir);
  } catch (err) {
    return singleDecision(
      plan,
      `triage failed (${(err as Error).message}); running as a single agent`,
    );
  }
  try {
    return normalizeDecision(raw, plan);
  } catch {
    return singleDecision(
      plan,
      "triage returned an invalid decision; running as a single agent",
    );
  }
}
