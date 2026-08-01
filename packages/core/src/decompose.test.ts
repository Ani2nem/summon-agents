import { describe, expect, it } from "vitest";
import {
  fileAllowed,
  laneOverlaps,
  matchGlob,
  outOfLaneFiles,
} from "./decompose.js";
import type { Subtask } from "./ports.js";

const sub = (slug: string, allowedFiles: string[]): Subtask => ({
  slug,
  title: slug,
  instructions: "x",
  allowedFiles,
});

describe("matchGlob", () => {
  it("handles exact, single-star, double-star, and dir-prefix", () => {
    expect(matchGlob("src/api/routes.ts", "src/api/routes.ts")).toBe(true);
    expect(matchGlob("src/api/routes.ts", "src/api/*.ts")).toBe(true);
    expect(matchGlob("src/api/routes.ts", "src/*.ts")).toBe(false); // * is single-segment
    expect(matchGlob("src/api/deep/x.ts", "src/**")).toBe(true);
    expect(matchGlob("src/api/x.ts", "src/api/")).toBe(true); // dir prefix
    expect(matchGlob("src/apix.ts", "src/api/")).toBe(false);
  });
});

describe("fileAllowed", () => {
  it("is true only when a pattern covers the file", () => {
    const allow = ["src/auth/**", "src/shared/types.ts"];
    expect(fileAllowed("src/auth/login.ts", allow)).toBe(true);
    expect(fileAllowed("src/shared/types.ts", allow)).toBe(true);
    expect(fileAllowed("src/api/routes.ts", allow)).toBe(false);
  });
});

describe("outOfLaneFiles (loophole C backstop)", () => {
  it("flags edits outside the declared lane, ignoring hotspots", () => {
    const s = sub("auth", ["src/auth/**"]);
    const changed = [
      "src/auth/login.ts", // in lane
      "src/api/routes.ts", // OUT of lane
      "package.json", // hotspot - ignored here
    ];
    expect(outOfLaneFiles(s, changed)).toEqual(["src/api/routes.ts"]);
  });

  it("returns nothing when the lane is undeclared (avoid false positives)", () => {
    const s = sub("auth", []);
    expect(outOfLaneFiles(s, ["anything.ts"])).toEqual([]);
  });
});

describe("laneOverlaps", () => {
  it("detects shared identical entries", () => {
    const overlaps = laneOverlaps([
      sub("a", ["src/shared/util.ts", "src/a/**"]),
      sub("b", ["src/shared/util.ts", "src/b/**"]),
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.files).toContain("src/shared/util.ts");
  });

  it("detects a concrete path matching another lane's glob", () => {
    const overlaps = laneOverlaps([
      sub("a", ["src/auth/login.ts"]),
      sub("b", ["src/auth/**"]),
    ]);
    expect(overlaps).toHaveLength(1);
  });

  it("finds no overlap for genuinely disjoint lanes", () => {
    const overlaps = laneOverlaps([
      sub("a", ["src/auth/**"]),
      sub("b", ["src/api/**"]),
    ]);
    expect(overlaps).toHaveLength(0);
  });
});
