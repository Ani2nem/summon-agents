import { describe, expect, it } from "vitest";
import { extractApprovedPlan, parseClaudeHookPlan } from "./claude.js";

describe("Claude Code approval-stage gate", () => {
  it("fires on a finalized ExitPlanMode PostToolUse with a plan", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "Build auth and api" },
      tool_response: { ok: true },
    };
    expect(extractApprovedPlan(payload)).toBe("Build auth and api");
  });

  it("no-ops on the propose stage (PreToolUse)", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "Build auth and api" },
    };
    expect(extractApprovedPlan(payload)).toBeNull();
  });

  it("no-ops for a different tool", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "x.ts", content: "..." },
    };
    expect(extractApprovedPlan(payload)).toBeNull();
  });

  it("no-ops when there is no plan text", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      tool_input: {},
    };
    expect(extractApprovedPlan(payload)).toBeNull();
  });

  it("parseClaudeHookPlan fails soft on non-JSON", () => {
    expect(parseClaudeHookPlan("not json")).toBeNull();
  });

  it("parseClaudeHookPlan reads a valid approval payload", () => {
    const raw = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "do the thing" },
    });
    expect(parseClaudeHookPlan(raw)).toBe("do the thing");
  });
});
