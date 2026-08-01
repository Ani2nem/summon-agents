// hotspots.ts - shared files that defeat file-disjointness (loophole C).
//
// "Disjoint files" is a lie in practice: even when code files differ, most real
// tasks both touch shared manifests - package.json, lockfiles, schemas,
// migrations, barrel indexes. These must be kept out of the parallel lanes and
// handled specially (deps installed once up front; manifests/schemas
// sequential-merged; lockfiles regenerated post-merge, not git-merged).
//
// Detection is deterministic here; the Judge may additionally flag project-
// specific hotspots (a shared DI registry, a central types file) that pattern
// matching cannot know about.

import * as path from "node:path";

/** A hotspot pattern is one of:
 *  - exact basename: "package.json"
 *  - extension glob:  "*.prisma"
 *  - path segment:    "migrations/" (matches if any dir segment equals it)
 */
// NOTE: only files that need NO hand-editing belong here - manifests and
// lockfiles that are regenerated/handled centrally. Do NOT list entry points or
// barrels (index.js/index.ts): those often need REAL edits (wiring), and
// reserving them out of every lane silently drops that work. Shared code files
// are instead assigned to a lane (see triage.reserveHotspots).
export const DEFAULT_HOTSPOT_PATTERNS: readonly string[] = [
  // JS/TS manifests + lockfiles
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  // Go
  "go.mod",
  "go.sum",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Python
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  // Ruby
  "Gemfile",
  "Gemfile.lock",
];

/** Manifest basenames (dependency/build config). Combined with lockfiles, these
 *  are the "mechanical" hotspots that are reserved + regenerated, never edited. */
export const MANIFEST_BASENAMES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Gemfile",
];

/**
 * True if `file` is a mechanical hotspot (manifest or lockfile): reserved out of
 * lanes and regenerated centrally, never hand-edited. Everything else the Judge
 * flags as a hotspot is treated as a shared CODE file that needs an owner.
 */
export function isMechanicalHotspot(file: string): boolean {
  const base = path.posix.basename(normalize(file));
  return isLockfile(file) || MANIFEST_BASENAMES.includes(base);
}

/** Lockfiles that must be regenerated post-merge rather than git-merged. */
export const LOCKFILE_BASENAMES: readonly string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "go.sum",
];

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True if `file` matches any of the given hotspot patterns. */
export function isHotspot(
  file: string,
  patterns: readonly string[] = DEFAULT_HOTSPOT_PATTERNS,
): boolean {
  const norm = normalize(file);
  const base = path.posix.basename(norm);
  const segments = norm.split("/");
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      const seg = pattern.slice(0, -1);
      if (segments.includes(seg)) return true;
    } else if (pattern.startsWith("*.")) {
      if (base.endsWith(pattern.slice(1))) return true;
    } else if (base === pattern) {
      return true;
    }
  }
  return false;
}

/** True if `file`'s basename is an auto-generated lockfile. */
export function isLockfile(file: string): boolean {
  return LOCKFILE_BASENAMES.includes(path.posix.basename(normalize(file)));
}

/**
 * Detect hotspot files among a set of candidate paths, merging the defaults with
 * any extra project-specific patterns the Judge supplied.
 */
export function detectHotspots(
  files: readonly string[],
  extraPatterns: readonly string[] = [],
): string[] {
  const patterns = [...DEFAULT_HOTSPOT_PATTERNS, ...extraPatterns];
  const seen = new Set<string>();
  for (const f of files) {
    if (isHotspot(f, patterns)) seen.add(normalize(f));
  }
  return [...seen];
}
