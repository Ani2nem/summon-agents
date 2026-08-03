import { describe, expect, it } from "vitest";
import type { ConflictContext, Judge, TriageDecision } from "./ports.js";
import { normalizeDecision, reserveHotspots, runTriage } from "./triage.js";

/** A Judge whose triage output is fixed per test; never resolves conflicts. */
function fakeJudge(
  triageImpl: (plan: string) => Promise<TriageDecision> | TriageDecision,
): Judge {
  return {
    async triage(plan) {
      return triageImpl(plan);
    },
    async resolveConflict(_ctx: ConflictContext) {
      return false;
    },
  };
}

const split = (
  subtasks: TriageDecision["subtasks"],
  extra: Partial<TriageDecision> = {},
): TriageDecision => ({
  mode: "split",
  reason: "test split",
  subtasks,
  hotspotFiles: [],
  preInstall: [],
  ...extra,
});

describe("reserveHotspots", () => {
  it("strips mechanical hotspot entries from lanes and collects them", () => {
    const decision = split([
      {
        slug: "auth",
        title: "auth",
        instructions: "x",
        allowedFiles: ["src/auth/**", "package.json"],
      },
      {
        slug: "api",
        title: "api",
        instructions: "x",
        allowedFiles: ["src/api/**", "pnpm-lock.yaml"],
      },
    ]);
    const reserved = reserveHotspots(decision);
    expect(reserved.subtasks[0]!.allowedFiles).toEqual(["src/auth/**"]);
    expect(reserved.subtasks[1]!.allowedFiles).toEqual(["src/api/**"]);
    expect(reserved.hotspotFiles).toContain("package.json");
    expect(reserved.hotspotFiles).toContain("pnpm-lock.yaml");
  });

  it("assigns a code hotspot (index.js wiring) to ONE lane instead of dropping it", () => {
    const decision = split(
      [
        { slug: "greeting", title: "g", instructions: "build greeting", allowedFiles: ["src/greeting.js"] },
        { slug: "farewell", title: "f", instructions: "build farewell", allowedFiles: ["src/farewell.js"] },
      ],
      { hotspotFiles: ["src/index.js", "package.json"] },
    );
    const reserved = reserveHotspots(decision, "THE FULL PLAN");

    // package.json is mechanical (reserved); src/index.js is code (assigned).
    expect(reserved.hotspotFiles).toEqual(["package.json"]);
    const owners = reserved.subtasks.filter((s) =>
      s.allowedFiles.includes("src/index.js"),
    );
    expect(owners).toHaveLength(1); // owned by exactly one lane, not dropped
    expect(reserved.subtasks[0]!.instructions).toContain("THE FULL PLAN");
  });
});

describe("normalizeDecision (the brake)", () => {
  it("keeps a clean disjoint split", () => {
    const d = normalizeDecision(
      split([
        { slug: "auth", title: "a", instructions: "x", allowedFiles: ["src/auth/**"] },
        { slug: "api", title: "b", instructions: "x", allowedFiles: ["src/api/**"] },
      ]),
      "PLAN",
    );
    expect(d.mode).toBe("split");
    expect(d.subtasks).toHaveLength(2);
  });

  it("coerces to single when only one subtask is proposed", () => {
    const d = normalizeDecision(
      split([
        { slug: "solo", title: "s", instructions: "x", allowedFiles: ["src/**"] },
      ]),
      "PLAN",
    );
    expect(d.mode).toBe("single");
    expect(d.subtasks).toHaveLength(1);
  });

  it("coerces to single when lanes overlap on real code (post-reservation)", () => {
    const d = normalizeDecision(
      split([
        {
          slug: "a",
          title: "a",
          instructions: "x",
          allowedFiles: ["src/shared/util.ts", "src/a/**"],
        },
        {
          slug: "b",
          title: "b",
          instructions: "x",
          allowedFiles: ["src/shared/util.ts", "src/b/**"],
        },
      ]),
      "PLAN",
    );
    expect(d.mode).toBe("single");
    expect(d.reason).toMatch(/overlap/i);
    expect(d.subtasks[0]!.instructions).toBe("PLAN");
  });

  it("keeps wiring owned end-to-end: a split with index.js in hotspots does not drop it", () => {
    const d = normalizeDecision(
      split(
        [
          { slug: "greeting", title: "g", instructions: "build greeting", allowedFiles: ["src/greeting.js"] },
          { slug: "farewell", title: "f", instructions: "build farewell", allowedFiles: ["src/farewell.js"] },
        ],
        { hotspotFiles: ["src/index.js"] },
      ),
      "PLAN",
    );
    expect(d.mode).toBe("split");
    const owned = d.subtasks.some((s) => s.allowedFiles.includes("src/index.js"));
    expect(owned).toBe(true);
  });

  it("does NOT collapse a split just because lanes share a hotspot", () => {
    // Both touch package.json (a hotspot) but disjoint code -> stays split.
    const d = normalizeDecision(
      split([
        {
          slug: "a",
          title: "a",
          instructions: "x",
          allowedFiles: ["src/a/**", "package.json"],
        },
        {
          slug: "b",
          title: "b",
          instructions: "x",
          allowedFiles: ["src/b/**", "package.json"],
        },
      ]),
      "PLAN",
    );
    expect(d.mode).toBe("split");
    expect(d.hotspotFiles).toContain("package.json");
  });

  it("makes duplicate slugs unique", () => {
    const d = normalizeDecision(
      split([
        { slug: "x", title: "a", instructions: "i", allowedFiles: ["src/a/**"] },
        { slug: "x", title: "b", instructions: "i", allowedFiles: ["src/b/**"] },
      ]),
      "PLAN",
    );
    const slugs = d.subtasks.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("runTriage fallback", () => {
  it("falls back to single agent when the Judge throws", async () => {
    const judge = fakeJudge(() => {
      throw new Error("model unavailable");
    });
    const d = await runTriage(judge, "PLAN", "/repo");
    expect(d.mode).toBe("single");
    expect(d.reason).toMatch(/triage failed/i);
    expect(d.subtasks[0]!.instructions).toBe("PLAN");
  });

  it("falls back to single agent when the Judge returns garbage", async () => {
    // Invalid: empty subtasks violates the schema.
    const judge = fakeJudge(() => split([]));
    const d = await runTriage(judge, "PLAN", "/repo");
    expect(d.mode).toBe("single");
  });

  it("prepends the triage hint for the judge only, never into the plan/wiring", async () => {
    let seen = "";
    // Return an invalid decision so runTriage falls back to a single agent whose
    // instructions are the ORIGINAL plan - proving the hint didn't leak in.
    const judge = fakeJudge((plan) => {
      seen = plan;
      return split([]);
    });
    const d = await runTriage(judge, "PLAN", "/repo", "GREENFIELD-HINT-XYZ");
    expect(seen).toContain("GREENFIELD-HINT-XYZ"); // judge saw the hint
    expect(seen).toContain("PLAN");
    expect(d.subtasks[0]!.instructions).toBe("PLAN"); // wiring = original plan
    expect(d.subtasks[0]!.instructions).not.toContain("GREENFIELD-HINT-XYZ");
  });

  it("passes through a valid split", async () => {
    const judge = fakeJudge(() =>
      split([
        { slug: "auth", title: "a", instructions: "x", allowedFiles: ["src/auth/**"] },
        { slug: "api", title: "b", instructions: "x", allowedFiles: ["src/api/**"] },
      ]),
    );
    const d = await runTriage(judge, "PLAN", "/repo");
    expect(d.mode).toBe("split");
    expect(d.subtasks).toHaveLength(2);
  });
});
