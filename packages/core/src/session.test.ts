import { describe, expect, it } from "vitest";
import { attachArgs, sessionName } from "./session.js";

describe("sessionName", () => {
  it("prefixes summon_ and sanitizes each segment", () => {
    expect(sessionName("run1", "auth")).toBe("summon_run1_auth");
  });

  it("replaces every char outside [A-Za-z0-9_] (dots, colons, slashes, hyphens) with _", () => {
    // Run ids are timestamp-prefixed and contain dots/colons/hyphens.
    const name = sessionName("2026-07-29T12:00:00.123Z-abc", "auth-flow");
    expect(name).toBe("summon_2026_07_29T12_00_00_123Z_abc_auth_flow");
    // No tmux-special characters survive.
    expect(name).not.toMatch(/[.:/-]/);
  });

  it("collapses slashes and spaces to _ and always keeps the summon_ prefix", () => {
    expect(sessionName("a/b", "c d")).toBe("summon_a_b_c_d");
    expect(sessionName("x", "y")).toMatch(/^summon_/);
  });
});

describe("attachArgs", () => {
  it("builds `attach -t <name>`", () => {
    expect(attachArgs("summon_r_s")).toEqual(["attach", "-t", "summon_r_s"]);
  });
});
