import { describe, expect, it } from "vitest";
import {
  type AgentCliConfig,
  agentCommandBuilder,
  agentConfigFromEnv,
  agentInteractiveArgs,
  agentInteractiveCommandBuilder,
  agentRunArgs,
  buildIntegrationPrompt,
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
  it("claude uses --permission-mode, or the skip flag under yolo, and always --strict-mcp-config", () => {
    const base = { vendor: "claude" as const, bin: "claude", permissionMode: "bypassPermissions", skipPermissions: false };
    // --strict-mcp-config is mandatory: it stops a headless worker from booting
    // summon-agents' OWN MCP server (registered in the repo's .mcp.json by init)
    // and hanging on its trust gate.
    expect(agentRunArgs(base, "hi")).toEqual(["-p", "hi", "--strict-mcp-config", "--permission-mode", "bypassPermissions"]);
    expect(agentRunArgs({ ...base, skipPermissions: true }, "hi")).toEqual(["-p", "hi", "--strict-mcp-config", "--dangerously-skip-permissions"]);
  });

  it("cursor uses --force to auto-approve", () => {
    const cfg = { vendor: "cursor" as const, bin: "cursor-agent", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(cfg, "hi")).toEqual(["-p", "hi", "--force"]);
  });

  it("copilot uses --allow-all-tools and drops built-in MCPs", () => {
    const cfg = { vendor: "copilot" as const, bin: "copilot", permissionMode: "bypassPermissions", skipPermissions: false };
    expect(agentRunArgs(cfg, "hi")).toEqual([
      "-p",
      "hi",
      "--allow-all-tools",
      "--disable-builtin-mcps",
    ]);
  });

  it("codex uses `exec` with the bypass flag and disables the summon MCP server", () => {
    const cfg = { vendor: "codex" as const, bin: "codex", permissionMode: "bypassPermissions", skipPermissions: false };
    // Codex reads MCP from the global config.toml; disable summon-agents there so
    // the worker doesn't recursively boot our own MCP.
    expect(agentRunArgs(cfg, "hi")).toEqual([
      "exec",
      "hi",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "mcp_servers.summon-agents.enabled=false",
    ]);
  });
});

describe("agentInteractiveArgs (per-vendor interactive/attended flags)", () => {
  it("claude seeds the prompt + --permission-mode, no headless -p", () => {
    const cfg = { vendor: "claude" as const, bin: "claude", permissionMode: "bypassPermissions", skipPermissions: false };
    const args = agentInteractiveArgs(cfg, "hi");
    expect(args).toEqual(["hi", "--strict-mcp-config", "--permission-mode", "bypassPermissions"]);
    expect(args).toContain("hi");
    expect(args).not.toContain("-p");
  });

  it("cursor seeds the prompt + --force, no headless -p", () => {
    const cfg = { vendor: "cursor" as const, bin: "cursor-agent", permissionMode: "bypassPermissions", skipPermissions: false };
    const args = agentInteractiveArgs(cfg, "hi");
    expect(args).toEqual(["hi", "--force"]);
    expect(args).toContain("--force");
    expect(args).not.toContain("-p");
  });

  it("copilot seeds the prompt + --allow-all-tools, no headless -p", () => {
    const cfg = { vendor: "copilot" as const, bin: "copilot", permissionMode: "bypassPermissions", skipPermissions: false };
    const args = agentInteractiveArgs(cfg, "hi");
    expect(args).toEqual(["hi", "--allow-all-tools", "--disable-builtin-mcps"]);
    expect(args).toContain("--allow-all-tools");
    expect(args).not.toContain("-p");
  });

  it("codex seeds the prompt (no `exec`) and disables the summon MCP server", () => {
    const cfg = { vendor: "codex" as const, bin: "codex", permissionMode: "bypassPermissions", skipPermissions: false };
    const args = agentInteractiveArgs(cfg, "hi");
    expect(args).toEqual(["hi", "-c", "mcp_servers.summon-agents.enabled=false"]);
    expect(args).toContain("hi");
    expect(args).not.toContain("exec");
  });
});

describe("agentInteractiveCommandBuilder", () => {
  it("seeds the same task prompt into the interactive TUI, without the headless flag", () => {
    const build = agentInteractiveCommandBuilder({
      vendor: "claude",
      bin: "claude",
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
    expect(cmd.command).toBe("claude");
    const joined = cmd.args.join(" ");
    // the seeded task prompt is present...
    expect(joined).toContain("Add auth");
    expect(joined).toContain("Create src/auth.js exporting login()");
    // ...but NOT the headless print flag
    expect(cmd.args).not.toContain("-p");
    expect(cmd.args).toContain("--permission-mode");
  });

  it("honors a custom bin and omits `exec` for codex", () => {
    const build = agentInteractiveCommandBuilder({
      vendor: "codex",
      bin: "/opt/codex",
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
    expect(cmd.command).toBe("/opt/codex");
    expect(cmd.args).not.toContain("exec");
    expect(cmd.args.join(" ")).toContain("implement everything");
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
    // L1: hard boundary + self-containment - the agent must NOT invent a shared
    // file (a server/router/root config) outside its lane, it must plug in by
    // convention. This is the fix for convergent out-of-lane drift.
    expect(joined).toContain("HARD BOUNDARY");
    expect(joined.toLowerCase()).toContain("self-contained");
    expect(joined.toLowerCase()).toContain("plug in by convention");
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
    // ...and must NOT get the hard-boundary clause, which only applies to lanes
    expect(joined).not.toContain("HARD BOUNDARY");
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

  it("parses an integration task when the judge emits one; defaults to null otherwise", () => {
    const withInt = parseTriageResponse(
      `{"mode":"split","reason":"r","subtasks":[{"slug":"a","title":"A","instructions":"i","allowedFiles":["pages/a/**"]},{"slug":"b","title":"B","instructions":"i","allowedFiles":["pages/b/**"]}],"integration":{"title":"server","instructions":"serve both pages"}}`,
      "PLAN",
    );
    expect(withInt.integration?.instructions).toBe("serve both pages");
    const without = parseTriageResponse(
      `{"mode":"split","reason":"r","subtasks":[{"slug":"a","title":"A","instructions":"i","allowedFiles":["pages/a/**"]}],"hotspotFiles":[]}`,
      "PLAN",
    );
    expect(without.integration).toBeNull();
  });
});

describe("buildIntegrationPrompt", () => {
  it("tells the integrator to read the real pieces, wire (not rewrite), and commit", () => {
    const prompt = buildIntegrationPrompt({
      repoDir: "/tmp/intg",
      plan: "build two pages served by one server",
      instructions: "add a server that serves both pages",
      mergedSlugs: ["login", "dashboard"],
    });
    expect(prompt).toContain("INTEGRATION step");
    expect(prompt).toContain("add a server that serves both pages");
    // context: the pieces it must wire and the plan
    expect(prompt).toContain("login");
    expect(prompt).toContain("dashboard");
    expect(prompt).toContain("build two pages served by one server");
    // behavior: read the real pieces, connect not rewrite, commit
    expect(prompt.toLowerCase()).toContain("read");
    expect(prompt.toLowerCase()).toContain("do not rewrite");
    expect(prompt.toLowerCase()).toContain("commit");
  });
});
