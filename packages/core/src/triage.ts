// triage.ts - the deterministic wrapper around the Judge's split decision.
//
// The Judge (an LLM) decides *how* to split; this module makes the result safe
// and deterministic: reserve hotspots out of the lanes (loophole C), enforce the
// brake (coerce to a single agent when the work is not cleanly splittable), and
// fall back to single-agent on any judge failure rather than forking blindly.

import { detectHotspots, isMechanicalHotspot } from "./hotspots.js";
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
 * Handle hotspot files. Two kinds, treated very differently:
 *
 *  - MECHANICAL hotspots (manifests, lockfiles): reserved out of every lane and
 *    regenerated centrally. These never need hand-editing.
 *  - CODE hotspots (a shared entry point, barrel, router, types file that needs
 *    real edits): these must NOT be dropped. They are assigned to exactly ONE
 *    lane, which also receives the full plan for wiring context. This fixes the
 *    class of bug where "wire modules into index.js" silently vanished because
 *    index.js was reserved out of all lanes.
 *
 * `plan` is the full approved plan, appended to the owning lane so it has the
 * cross-cutting context needed to do the wiring.
 */
export function reserveHotspots(
  decision: TriageDecision,
  plan = "",
): TriageDecision {
  const allFiles = decision.subtasks.flatMap((s) => s.allowedFiles);
  const flagged = new Set<string>([
    ...decision.hotspotFiles.map(normalize),
    ...detectHotspots(allFiles),
  ]);
  const mechanical = [...flagged].filter(isMechanicalHotspot);
  const codeHotspots = [...flagged].filter((f) => !isMechanicalHotspot(f));

  // Strip only mechanical hotspots from every lane.
  const mechanicalSet = new Set(mechanical);
  let subtasks = decision.subtasks.map((s) => ({
    ...s,
    allowedFiles: s.allowedFiles.filter((f) => !mechanicalSet.has(normalize(f))),
  }));

  // Assign code hotspots to a single owning lane so the wiring gets done.
  if (codeHotspots.length > 0 && subtasks.length > 0) {
    const owner = subtasks[0]!;
    const allowedFiles = [
      ...new Set([...owner.allowedFiles, ...codeHotspots]),
    ];
    const note = `

## Shared files you also own (wiring)
You must make the changes described in the plan to these shared files:
${codeHotspots.map((f) => `- ${f}`).join("\n")}
Some modules referenced here are being created by other agents in parallel and
will exist only after merge. Write imports/wiring exactly as the plan specifies.
Do NOT create files owned by other tasks - only import them.

## Full plan (for wiring context)
${plan}`;
    subtasks = subtasks.map((s, i) =>
      i === 0 ? { ...owner, allowedFiles, instructions: owner.instructions + note } : s,
    );
  }

  return {
    ...decision,
    subtasks,
    hotspotFiles: mechanical.sort(),
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

  const reserved = reserveHotspots({ ...parsed, subtasks }, plan);

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
  /**
   * Extra context prepended to the plan for the JUDGE's decision only (e.g. a
   * greenfield note). It is deliberately NOT passed to normalizeDecision, so it
   * never leaks into the stored plan or the wiring context appended to lanes.
   */
  triageHint?: string,
): Promise<TriageDecision> {
  const judgePlan = triageHint ? `${triageHint}\n\n${plan}` : plan;
  let raw: TriageDecision;
  try {
    raw = await judge.triage(judgePlan, repoDir);
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
