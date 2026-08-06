import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMerge, type MergeTarget } from "./merge.js";
import type { ConflictContext, Judge } from "./ports.js";
import { branchNameFor, worktreePathFor } from "./run.js";
import { cleanupTempRepo, commitFile, makeTempRepo } from "./testkit.js";
import { addWorktree, git } from "./worktree.js";

const runId = "r1";

/** Judge that never resolves anything. */
const inertJudge: Judge = {
  async triage() {
    throw new Error("unused");
  },
  async resolveConflict() {
    return false;
  },
};

/** Create a worktree for a slug and write (uncommitted) files into it. */
async function makeLane(
  repo: string,
  slug: string,
  files: Record<string, string>,
): Promise<MergeTarget> {
  const worktree = worktreePathFor(repo, runId, slug);
  const branch = branchNameFor(runId, slug);
  await addWorktree({
    repoDir: repo,
    worktreePath: worktree,
    branch,
    baseBranch: "main",
  });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(worktree, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return { slug, branch, worktree };
}

describe("runMerge", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeTempRepo();
  });
  afterEach(async () => {
    await cleanupTempRepo(repo);
  });

  it("merges disjoint lanes onto the integration branch, leaving base clean", async () => {
    const auth = await makeLane(repo, "auth", {
      "src/auth/login.ts": "export const login = () => {};\n",
    });
    const api = await makeLane(repo, "api", {
      "src/api/routes.ts": "export const routes = [];\n",
    });

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [auth, api],
      judge: inertJudge,
    });

    expect(outcome.status).toBe("merged");
    // Base is left clean (not fast-forwarded) - the work lives on integration.
    await git(repo, ["checkout", "main"]);
    expect(await fileOnDisk(repo, "src/auth/login.ts")).toBe(false);
    expect(await fileOnDisk(repo, "src/api/routes.ts")).toBe(false);
    // Both files are present on the integration branch (the deliverable).
    await git(repo, ["checkout", outcome.integrationBranch]);
    expect(await fileOnDisk(repo, "src/auth/login.ts")).toBe(true);
    expect(await fileOnDisk(repo, "src/api/routes.ts")).toBe(true);
    await git(repo, ["checkout", "main"]);
  });

  it("loophole A: blocks on a clean-but-broken merge, then merges after the judge fixes it", async () => {
    // The repo declares its own validation command.
    await commitFile(
      repo,
      "package.json",
      JSON.stringify({ name: "t", scripts: { typecheck: "node check.js" } }),
    );
    await commitFile(
      repo,
      "check.js",
      `const fs=require("fs");process.exit(fs.readFileSync("marker.txt","utf8").trim()==="OK"?0:1);`,
    );
    await commitFile(repo, "marker.txt", "OK\n");

    // A lane flips the marker to a broken value (a clean git merge, broken code).
    const bad = await makeLane(repo, "bad", { "marker.txt": "BROKEN\n" });

    // Judge that repairs the marker when asked to fix validation.
    const fixingJudge: Judge = {
      async triage() {
        throw new Error("unused");
      },
      async resolveConflict(ctx: ConflictContext) {
        if (ctx.slug === "validation") {
          await fs.writeFile(path.join(ctx.repoDir, "marker.txt"), "OK\n");
          return true;
        }
        return false;
      },
    };

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [bad],
      judge: fixingJudge,
    });

    expect(outcome.validation.ran).toBe(true);
    expect(outcome.status).toBe("merged");
    expect(outcome.validation.ok).toBe(true);
  });

  it("loophole A: stays needsHuman when the judge cannot fix validation, base untouched", async () => {
    await commitFile(
      repo,
      "package.json",
      JSON.stringify({ name: "t", scripts: { typecheck: "node check.js" } }),
    );
    await commitFile(
      repo,
      "check.js",
      `const fs=require("fs");process.exit(fs.readFileSync("marker.txt","utf8").trim()==="OK"?0:1);`,
    );
    await commitFile(repo, "marker.txt", "OK\n");
    const bad = await makeLane(repo, "bad", { "marker.txt": "BROKEN\n" });

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [bad],
      judge: inertJudge,
    });

    expect(outcome.status).toBe("needsHuman");
    expect(outcome.reason).toMatch(/validation/i);
    // Base still on the good marker - not polluted by the failed run.
    await git(repo, ["checkout", "main"]);
    const marker = await fs.readFile(path.join(repo, "marker.txt"), "utf8");
    expect(marker.trim()).toBe("OK");
  });

  it("resolves a real conflict via the judge", async () => {
    await commitFile(repo, "shared.txt", "base\n");
    const a = await makeLane(repo, "a", { "shared.txt": "from-a\n" });
    const b = await makeLane(repo, "b", { "shared.txt": "from-b\n" });

    // Judge resolves by taking one side, leaving no markers.
    const resolvingJudge: Judge = {
      async triage() {
        throw new Error("unused");
      },
      async resolveConflict(ctx: ConflictContext) {
        await git(ctx.repoDir, ["checkout", "--theirs", "--", "."]);
        return true;
      },
    };

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [a, b],
      judge: resolvingJudge,
    });
    expect(outcome.status).toBe("merged");
  });

  it("integration step: wires the shared surface once, seeing every merged lane, and it lands validated", async () => {
    // The repo's own check passes ONLY if the shared server exists alongside both
    // pages - so validation would FAIL without integration, proving the wiring
    // ran before the gate.
    await commitFile(
      repo,
      "package.json",
      JSON.stringify({ name: "t", scripts: { typecheck: "node check.js" } }),
    );
    await commitFile(
      repo,
      "check.js",
      `const fs=require("fs");process.exit(fs.existsSync("server.js")&&fs.existsSync("pages/a.txt")&&fs.existsSync("pages/b.txt")?0:1);`,
    );

    // Two independent page lanes - neither builds the shared server.
    const a = await makeLane(repo, "login", { "pages/a.txt": "login page\n" });
    const b = await makeLane(repo, "dash", { "pages/b.txt": "dashboard page\n" });

    let sawBothPieces = false;
    let sawSlugs: string[] = [];
    const integratingJudge: Judge = {
      async triage() {
        throw new Error("unused");
      },
      async resolveConflict() {
        return false;
      },
      async integrate(ctx) {
        // It must run in a tree that already contains BOTH lanes' work.
        sawBothPieces =
          (await fileOnDisk(ctx.repoDir, "pages/a.txt")) &&
          (await fileOnDisk(ctx.repoDir, "pages/b.txt"));
        sawSlugs = ctx.mergedSlugs;
        await fs.writeFile(
          path.join(ctx.repoDir, "server.js"),
          "// serves pages/a.txt and pages/b.txt\n",
        );
        return true;
      },
    };

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [a, b],
      judge: integratingJudge,
      plan: "build two pages served by one server",
      integration: { title: "shared server", instructions: "serve both pages" },
    });

    expect(sawBothPieces).toBe(true); // integrator saw the finished pieces
    expect(sawSlugs.sort()).toEqual(["dash", "login"]);
    expect(outcome.status).toBe("merged");
    expect(outcome.validation.ran).toBe(true);
    expect(outcome.validation.ok).toBe(true);
    // The wired server is part of the deliverable on the integration branch.
    await git(repo, ["checkout", outcome.integrationBranch]);
    expect(await fileOnDisk(repo, "server.js")).toBe(true);
    await git(repo, ["checkout", "main"]);
    // The integrator's worktree is cleaned up, base untouched.
    expect(await fileOnDisk(repo, "server.js")).toBe(false);
  });

  it("integration step: gives up (returns false) -> needsHuman, base clean", async () => {
    const a = await makeLane(repo, "login", { "pages/a.txt": "login\n" });
    const givingUpJudge: Judge = {
      async triage() {
        throw new Error("unused");
      },
      async resolveConflict() {
        return false;
      },
      async integrate() {
        return false; // cannot wire it
      },
    };

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [a],
      judge: givingUpJudge,
      plan: "p",
      integration: { title: "shared server", instructions: "serve the page" },
    });

    expect(outcome.status).toBe("needsHuman");
    expect(outcome.reason).toMatch(/integration/i);
    // Base is a clean checkout of main, no worktree or branch left dangling in it.
    await git(repo, ["checkout", "main"]);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("no integration task: behaves exactly as before (skips the step)", async () => {
    const a = await makeLane(repo, "a", { "src/a.ts": "export const a=1;\n" });
    // A judge whose integrate would throw if ever called - it must NOT be called.
    const judge: Judge = {
      async triage() {
        throw new Error("unused");
      },
      async resolveConflict() {
        return false;
      },
      async integrate() {
        throw new Error("integrate must not run without an integration task");
      },
    };
    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [a],
      judge,
      integration: null,
    });
    expect(outcome.status).toBe("merged");
  });

  it("aborts to needsHuman when a conflict is left unresolved, base clean", async () => {
    await commitFile(repo, "shared.txt", "base\n");
    const a = await makeLane(repo, "a", { "shared.txt": "from-a\n" });
    const b = await makeLane(repo, "b", { "shared.txt": "from-b\n" });

    const outcome = await runMerge({
      repoRoot: repo,
      runId,
      baseBranch: "main",
      targets: [a, b],
      judge: inertJudge, // resolveConflict returns false
    });

    expect(outcome.status).toBe("needsHuman");
    // Base is back to a clean checkout of main with no merge in progress.
    await git(repo, ["checkout", "main"]);
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status).toBe("");
  });
});

async function fileOnDisk(repo: string, rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(repo, rel));
    return true;
  } catch {
    return false;
  }
}
