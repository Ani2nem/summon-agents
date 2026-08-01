// decompose.ts - disjointness enforcement for the parallel lanes.
//
// The Judge proposes subtasks with an allowedFiles allow-list each. These
// helpers enforce that contract deterministically: detect overlapping lanes
// (which would defeat parallelism) and detect out-of-lane edits after an agent
// runs (loophole C backstop, before merge).

import * as path from "node:path";
import { isHotspot } from "./hotspots.js";
import type { Subtask } from "./ports.js";

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Minimal glob matcher supporting `**`, `*`, and `?`. Enough for allow-lists
 * like `src/auth/**`, `*.ts`, `src/api/routes.ts`. No brace/character classes.
 */
export function matchGlob(file: string, pattern: string): boolean {
  const f = normalize(file);
  const p = normalize(pattern);
  if (p === f) return true;
  // Directory prefix shorthand: "src/auth/" matches anything under it.
  if (p.endsWith("/")) return f === p.slice(0, -1) || f.startsWith(p);
  const re = globToRegExp(p);
  return re.test(f);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**" - match across path separators
        re += ".*";
        i++;
        // consume an immediately following slash so "a/**/b" matches "a/b"
        if (glob[i + 1] === "/") i++;
      } else {
        // single "*" - match within a path segment
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `file` is covered by any pattern in the allow-list. */
export function fileAllowed(
  file: string,
  allowedFiles: readonly string[],
): boolean {
  return allowedFiles.some((pattern) => matchGlob(file, pattern));
}

/**
 * Files an agent changed that fall outside its declared allow-list. Hotspot
 * files are excluded here because they are handled by the sequential/reservation
 * path, not the per-lane contract. If the subtask declared no allow-list, we
 * cannot judge and return nothing (avoid false positives).
 */
export function outOfLaneFiles(
  subtask: Subtask,
  changedFiles: readonly string[],
  hotspotPatterns?: readonly string[],
): string[] {
  if (subtask.allowedFiles.length === 0) return [];
  return changedFiles
    .map(normalize)
    .filter(
      (f) =>
        !fileAllowed(f, subtask.allowedFiles) &&
        !isHotspot(f, hotspotPatterns),
    );
}

export interface LaneOverlap {
  a: string; // slug
  b: string; // slug
  files: string[]; // representative overlapping patterns/paths
}

/**
 * Detect pairs of subtasks whose lanes overlap. Practical (not exhaustive over
 * arbitrary globs): flags shared identical entries, and concrete paths in one
 * lane that match a pattern in another. Overlaps mean the split is not truly
 * parallelizable and should be merged/sequenced or coerced to single (the brake).
 */
export function laneOverlaps(subtasks: readonly Subtask[]): LaneOverlap[] {
  const overlaps: LaneOverlap[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i]!;
      const b = subtasks[j]!;
      const shared = new Set<string>();
      for (const pa of a.allowedFiles) {
        for (const pb of b.allowedFiles) {
          if (normalize(pa) === normalize(pb)) {
            shared.add(normalize(pa));
          } else if (!hasGlob(pa) && matchGlob(pa, pb)) {
            shared.add(normalize(pa));
          } else if (!hasGlob(pb) && matchGlob(pb, pa)) {
            shared.add(normalize(pb));
          }
        }
      }
      if (shared.size > 0) {
        overlaps.push({ a: a.slug, b: b.slug, files: [...shared] });
      }
    }
  }
  return overlaps;
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern) || pattern.endsWith("/");
}

/** Basename helper reused by callers building instruction files. */
export function baseName(file: string): string {
  return path.posix.basename(normalize(file));
}
