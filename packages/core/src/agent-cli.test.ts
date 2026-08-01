import { describe, expect, it } from "vitest";
import {
  agentConfigFromEnv,
  claudeCommandBuilder,
  parseTriageResponse,
} from "./agent-cli.js";

describe("agentConfigFromEnv", () => {
  it("defaults to unattended (bypassPermissions)", () => {
    const cfg = agentConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.bin).toBe("claude");
    expect(cfg.permissionMode).toBe("bypassPermissions");
    expect(cfg.skipPermissions).toBe(false);
  });

  it("honors env overrides", () => {
    const cfg = agentConfigFromEnv({
      SUMMON_AGENT_BIN: "cursor-agent",
      SUMMON_PERMISSION_MODE: "acceptEdits",
      SUMMON_YOLO: "1",
    } as NodeJS.ProcessEnv);
    expect(cfg.bin).toBe("cursor-agent");
    expect(cfg.permissionMode).toBe("acceptEdits");
    expect(cfg.skipPermissions).toBe(true);
  });
});

describe("claudeCommandBuilder", () => {
  it("points the agent at its INSTRUCTIONS.md and passes permission args", () => {
    const build = claudeCommandBuilder({
      bin: "claude",
      permissionMode: "bypassPermissions",
      skipPermissions: false,
    });
    const cmd = build({ runDir: "/runs/r1/auth" });
    expect(cmd.command).toBe("claude");
    expect(cmd.args).toContain("-p");
    expect(cmd.args.join(" ")).toContain("/runs/r1/auth/INSTRUCTIONS.md");
    expect(cmd.args).toContain("--permission-mode");
    expect(cmd.args).toContain("bypassPermissions");
  });

  it("uses the skip flag when yolo is set", () => {
    const build = claudeCommandBuilder({
      bin: "claude",
      permissionMode: "bypassPermissions",
      skipPermissions: true,
    });
    const cmd = build({ runDir: "/runs/r1/auth" });
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.args).not.toContain("--permission-mode");
  });
});

describe("parseTriageResponse", () => {
  it("extracts a JSON decision embedded in prose", () => {
    const text = `Here is the plan:\n{"mode":"split","reason":"r","subtasks":[{"slug":"a","title":"A","instructions":"i","allowedFiles":["src/a/**"]}],"hotspotFiles":[],"preInstall":[]}\nDone.`;
    const d = parseTriageResponse(text, "PLAN");
    expect(d.mode).toBe("split");
    expect(d.subtasks[0]!.slug).toBe("a");
  });

  it("falls back to single-agent on unparseable output", () => {
    const d = parseTriageResponse("no json here", "PLAN");
    expect(d.mode).toBe("single");
    expect(d.subtasks[0]!.instructions).toBe("PLAN");
  });
});
