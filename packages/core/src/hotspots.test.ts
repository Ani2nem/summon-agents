import { describe, expect, it } from "vitest";
import {
  detectHotspots,
  isHotspot,
  isLockfile,
  isMechanicalHotspot,
} from "./hotspots.js";

describe("hotspots", () => {
  it("matches known manifests and lockfiles", () => {
    expect(isHotspot("package.json")).toBe(true);
    expect(isHotspot("apps/web/package.json")).toBe(true);
    expect(isHotspot("pnpm-lock.yaml")).toBe(true);
  });

  it("does NOT flag entry points / barrels as hotspots (they need real edits)", () => {
    // Reserving these out of every lane silently dropped wiring work.
    expect(isHotspot("src/index.ts")).toBe(false);
    expect(isHotspot("src/index.js")).toBe(false);
  });

  it("classifies mechanical vs code hotspots", () => {
    expect(isMechanicalHotspot("package.json")).toBe(true);
    expect(isMechanicalHotspot("pnpm-lock.yaml")).toBe(true);
    expect(isMechanicalHotspot("go.mod")).toBe(true);
    // A shared code file is NOT mechanical - it needs an owner, not regeneration.
    expect(isMechanicalHotspot("src/index.js")).toBe(false);
    expect(isMechanicalHotspot("src/types.ts")).toBe(false);
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
