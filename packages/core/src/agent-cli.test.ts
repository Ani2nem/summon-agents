import { describe, expect, it } from "vitest";
import {
  agentCommandBuilder,
  agentConfigFromEnv,
  agentRunArgs,
  normalizeVendor,
  parseTriageResponse,
} from "./agent-cli.js";

describe("agentConfigFromEnv", () => {
  it("defaults to the claude vendor, unattended (bypassPermissions)", () => {
    const cfg = agentConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.vendor).toBe("claude");
    expect(cfg.bin).toBe("claude");
    expect(cfg.permissionMode).toBe("bypassPermissions");
    expect(cfg.skipPermissions).toBe(false);
  });

  it("selects the vendor binary from SUMMON_AGENT_VENDOR", () => {
    const cursor = agentConfigFromEnv({
      SUMMON_AGENT_VENDOR: "cursor",
    } as NodeJS.ProcessEnv);
    expect(cursor.vendor).toBe("cursor");
    expect(cursor.bin).toBe("cursor-agent");

    const copilot = agentConfigFromEnv({
      SUMMON_AGENT_VENDOR: "copilot",
    } as NodeJS.ProcessEnv);
    expect(copilot.vendor).toBe("copilot");
    expect(copilot.bin).toBe("copilot");
  });

  it("lets SUMMON_AGENT_BIN override the vendor's default binary", () => {
    const cfg = agentConfigFromEnv({
      SUMMON_AGENT_VENDOR: "cursor",
      SUMMON_AGENT_BIN: "/opt/custom/cursor-agent",
      SUMMON_PERMISSION_MODE: "acceptEdits",
      SUMMON_YOLO: "1",
    } as NodeJS.ProcessEnv);
    expect(cfg.vendor).toBe("cursor");
    expect(cfg.bin).toBe("/opt/custom/cursor-agent");
    expect(cfg.permissionMode).toBe("acceptEdits");
    expect(cfg.skipPermissions).toBe(true);
  });

  it("falls back to claude for unknown vendors", () => {
    expect(normalizeVendor("nonsense")).toBe("claude");
    expect(normalizeVendor(undefined)).toBe("claude");
    expect(normalizeVendor("cursor-agent")).toBe("cursor");
    expect(normalizeVendor("github-copilot")).toBe("copilot");
  });
});

describe("agentRunArgs (per-vendor headless flags)", () => {
  it("claude uses --permission-mode, or the skip flag under yolo", () => {
    const base = { vendor: "claude" as const, bin: "claude", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(base, "hi")).toEqual(["-p", "hi", "--permission-mode", "bypassPermissions"]);
    expect(agentRunArgs({ ...base, skipPermissions: true }, "hi")).toEqual(["-p", "hi", "--dangerously-skip-permissions"]);
  });

  it("cursor uses --force to auto-approve", () => {
    const cfg = { vendor: "cursor" as const, bin: "cursor-agent", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(cfg, "hi")).toEqual(["-p", "hi", "--force"]);
  });

  it("copilot uses --allow-all-tools", () => {
    const cfg = { vendor: "copilot" as const, bin: "copilot", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(cfg, "hi")).toEqual(["-p", "hi", "--allow-all-tools"]);
  });
});

describe("agentCommandBuilder", () => {
  it("inlines the task into the prompt (no external file to read) with vendor args", () => {
    const build = agentCommandBuilder({
      vendor: "cursor",
      bin: "cursor-agent",
      permissionMode: "bypassPermissions",
      skipPermissions: false,
    });
    const cmd = build({
      subtask: {
        slug: "auth",
        title: "Add auth",
        instructions: "Create src/auth.js exporting login()",
        allowedFiles: ["src/auth.js"],
      },
      runDir: "/runs/r1/auth",
    });
    expect(cmd.command).toBe("cursor-agent");
    expect(cmd.args).toContain("-p");
    const joined = cmd.args.join(" ");
    expect(joined).toContain("Add auth");
    expect(joined).toContain("Create src/auth.js exporting login()");
    expect(joined).toContain("src/auth.js"); // the lane
    expect(joined).toContain("commit"); // told to commit
    expect(cmd.args).toContain("--force");
    // must NOT depend on reading a file outside the sandbox
    expect(joined).not.toContain("INSTRUCTIONS.md");
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
