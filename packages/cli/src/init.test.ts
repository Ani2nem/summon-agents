import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRIGGER_BODY,
  claudeCommandFile,
  copilotPromptFile,
  cursorRuleFile,
  runInit,
} from "./init.js";

describe("shared trigger body (vendor-agnostic)", () => {
  it("drives the summon_agents MCP tool and forbids inline implementation", () => {
    expect(TRIGGER_BODY).toContain("summon_agents");
    expect(TRIGGER_BODY).toMatch(/plan.*argument/i);
    expect(TRIGGER_BODY).toMatch(/do not implement the plan yourself/i);
  });

  it("every host wraps the SAME body (only format differs)", () => {
    for (const f of [claudeCommandFile, cursorRuleFile, copilotPromptFile]) {
      expect(f("/repo").contents).toContain(TRIGGER_BODY);
    }
  });

  it("writes each host's file to the right vendor path", () => {
    expect(claudeCommandFile("/repo").path).toBe(
      "/repo/.claude/commands/summon-agents.md",
    );
    expect(cursorRuleFile("/repo").path).toBe(
      "/repo/.cursor/rules/summon-agents.mdc",
    );
    expect(copilotPromptFile("/repo").path).toBe(
      "/repo/.github/prompts/summon-agents.prompt.md",
    );
  });
});

describe("runInit (claude-code)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "summon-init-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the slash command, MCP registration, and gitignore entry", async () => {
    await runInit(dir, "claude-code");

    const cmd = await fs.readFile(
      path.join(dir, ".claude/commands/summon-agents.md"),
      "utf8",
    );
    expect(cmd).toContain("Dispatch the approved plan");
    expect(cmd).toContain("summon_agents");

    const mcp = JSON.parse(
      await fs.readFile(path.join(dir, ".mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers["summon-agents"].args).toContain("summon-agents-mcp");
    // Claude Code -> Claude workers.
    expect(mcp.mcpServers["summon-agents"].env.SUMMON_AGENT_VENDOR).toBe(
      "claude",
    );

    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".summon-agents/");

    // It must NOT write the broken ExitPlanMode hook anymore.
    const settingsExists = await fs
      .access(path.join(dir, ".claude/settings.json"))
      .then(() => true)
      .catch(() => false);
    expect(settingsExists).toBe(false);
  });

  it("uses the VS Code `servers` key for copilot, with the copilot vendor", async () => {
    await runInit(dir, "copilot");
    const mcp = JSON.parse(
      await fs.readFile(path.join(dir, ".vscode/mcp.json"), "utf8"),
    );
    expect(mcp.servers["summon-agents"]).toBeTruthy();
    expect(mcp.servers["summon-agents"].env.SUMMON_AGENT_VENDOR).toBe("copilot");
    expect(mcp.mcpServers).toBeUndefined();
  });

  it("bakes the cursor vendor into the Cursor MCP config", async () => {
    await runInit(dir, "cursor");
    const mcp = JSON.parse(
      await fs.readFile(path.join(dir, ".cursor/mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers["summon-agents"].env.SUMMON_AGENT_VENDOR).toBe(
      "cursor",
    );
  });
});
