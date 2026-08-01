import { describe, expect, it } from "vitest";
import { detectHotspots, isHotspot, isLockfile } from "./hotspots.js";

describe("hotspots", () => {
  it("matches known manifests, lockfiles, schemas, and migration dirs", () => {
    expect(isHotspot("package.json")).toBe(true);
    expect(isHotspot("apps/web/package.json")).toBe(true);
    expect(isHotspot("pnpm-lock.yaml")).toBe(true);
    expect(isHotspot("prisma/schema.prisma")).toBe(true);
    expect(isHotspot("db/migrations/0001_init.sql")).toBe(true);
    expect(isHotspot("src/index.ts")).toBe(true); // barrel
  });

  it("does not flag ordinary source files", () => {
    expect(isHotspot("src/auth/login.ts")).toBe(false);
    expect(isHotspot("src/api/routes.ts")).toBe(false);
  });

  it("identifies lockfiles specifically (for regenerate-not-merge)", () => {
    expect(isLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isLockfile("apps/web/package-lock.json")).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
  });

  it("detectHotspots returns the hotspot subset of a file set", () => {
    const found = detectHotspots([
      "src/auth/login.ts",
      "package.json",
      "src/api/routes.ts",
      "pnpm-lock.yaml",
    ]);
    expect(found.sort()).toEqual(["package.json", "pnpm-lock.yaml"]);
  });
});
