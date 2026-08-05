import { describe, expect, it } from "vitest";
import {
  type AgentCliConfig,
  agentCommandBuilder,
  agentConfigFromEnv,
  agentRunArgs,
  normalizeVendor,
  parseSessionId,
  parseTriageResponse,
  resumeCommand,
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

    const codex = agentConfigFromEnv({
      SUMMON_AGENT_VENDOR: "codex",
    } as NodeJS.ProcessEnv);
    expect(codex.vendor).toBe("codex");
    expect(codex.bin).toBe("codex");
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
    expect(normalizeVendor("codex")).toBe("codex");
    expect(normalizeVendor("openai")).toBe("codex");
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

  it("codex uses `exec` with the bypass flag", () => {
    const cfg = { vendor: "codex" as const, bin: "codex", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(cfg, "hi")).toEqual(["exec", "hi", "--dangerously-bypass-approvals-and-sandbox"]);
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
    // greenfield fix: keep scaffolding inside the lane, never at the repo root
    expect(joined).toContain("YOUR LANE");
    expect(joined.toLowerCase()).toContain("repository root");
    expect(joined.toLowerCase()).toContain("scaffold");
  });

  it("omits the lane/root restriction for a single agent (empty allowedFiles)", () => {
    const build = agentCommandBuilder({
      vendor: "claude",
      bin: "claude",
      permissionMode: "bypassPermissions",
      skipPermissions: false,
    });
    const cmd = build({
      subtask: {
        slug: "main",
        title: "Do the whole plan",
        instructions: "implement everything",
        allowedFiles: [],
      },
      runDir: "/r",
    });
    const joined = cmd.args.join(" ");
    expect(joined).toContain("implement everything");
    // a single agent owns the whole repo - it MUST be free to touch the root
    expect(joined).not.toContain("YOUR LANE");
    expect(joined.toLowerCase()).not.toContain("repository root");
  });
});

describe("resumeCommand (per-vendor resume flags)", () => {
  const cfg = (vendor: AgentCliConfig["vendor"], bin: string): AgentCliConfig => ({
    vendor,
    bin,
    permissionMode: "bypassPermissions",
    skipPermissions: false,
  });

  it("claude uses `--resume <id>`", () => {
    expect(resumeCommand(cfg("claude", "claude"), "sid")).toEqual({
      command: "claude",
      args: ["--resume", "sid"],
    });
  });

  it("cursor uses `--resume=<id>`", () => {
    expect(resumeCommand(cfg("cursor", "cursor-agent"), "sid")).toEqual({
      command: "cursor-agent",
      args: ["--resume=sid"],
    });
  });

  it("copilot uses `--resume=<id>`", () => {
    expect(resumeCommand(cfg("copilot", "copilot"), "sid")).toEqual({
      command: "copilot",
      args: ["--resume=sid"],
    });
  });

  it("codex uses `exec resume <id>`", () => {
    expect(resumeCommand(cfg("codex", "codex"), "sid")).toEqual({
      command: "codex",
      args: ["exec", "resume", "sid"],
    });
  });

  it("honors a custom bin", () => {
    expect(resumeCommand(cfg("cursor", "/opt/x"), "sid").command).toBe("/opt/x");
  });
});

describe("parseSessionId (best-effort from captured log)", () => {
  it("cursor lifts the id out of a `--resume=<id>` line", () => {
    const log = "...\nResume this later with: cursor-agent --resume=ses_ABC123\n";
    expect(parseSessionId("cursor", log)).toBe("ses_ABC123");
  });

  it("cursor handles the space form `--resume <id>`", () => {
    expect(parseSessionId("cursor", "copilot --resume abc-def-123 more")).toBe(
      "abc-def-123",
    );
  });

  it("copilot lifts the id out of a `--resume=<id>` line", () => {
    const log = "session saved. reopen: copilot --resume=01H9XYZ\n";
    expect(parseSessionId("copilot", log)).toBe("01H9XYZ");
  });

  it("cursor/copilot return undefined when no resume hint is present", () => {
    expect(parseSessionId("cursor", "no hint here")).toBeUndefined();
    expect(parseSessionId("copilot", "")).toBeUndefined();
  });

  it("codex (experimental) matches a labeled session/thread id", () => {
    expect(
      parseSessionId("codex", "thread_id: 0f8a1b2c-3d4e-5f60-7182-93a4b5c6d7e8"),
    ).toBe("0f8a1b2c-3d4e-5f60-7182-93a4b5c6d7e8");
    expect(parseSessionId("codex", "session id = ABC12345")).toBe("ABC12345");
  });

  it("claude always returns undefined (no resume id surfaced by -p)", () => {
    expect(
      parseSessionId("claude", "anything --resume=nope session: whatever"),
    ).toBeUndefined();
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
