import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("core scaffold", () => {
  it("exposes a version string", () => {
    expect(typeof VERSION).toBe("string");
  });
});
