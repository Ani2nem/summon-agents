// init.ts - install the editor hook + MCP registration for a project.
//
// Zero-setup is the headline: this writes a few lines into the host's config so
// approving a plan fires summon-agents. It merges into existing config rather
// than overwriting, and is idempotent.

import * as fs from "node:fs/promises";
import * as path from "node:path";

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

/** Install the Claude Code PostToolUse(ExitPlanMode) hook + MCP server. */
export async function runInit(repoRoot: string, host: string): Promise<void> {
  if (host !== "claude-code") {
    process.stdout.write(
      `summon-agents: init for "${host}" is not implemented yet (claude-code only)\n`,
    );
    return;
  }

  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const settings = await readJson(settingsPath);

  // Hook: fire summon-agents on plan approval (ExitPlanMode PostToolUse).
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const postToolUse = (hooks.PostToolUse as unknown[]) ?? [];
  const command = "npx -y summon-agents run --from-hook --host claude-code";
  const alreadyHooked = JSON.stringify(postToolUse).includes("summon-agents run");
  if (!alreadyHooked) {
    postToolUse.push({
      matcher: "ExitPlanMode",
      hooks: [{ type: "command", command }],
    });
  }
  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;

  await writeJson(settingsPath, settings);

  // MCP registration (used by the M2 server; harmless to write now).
  const mcpPath = path.join(repoRoot, ".mcp.json");
  const mcp = await readJson(mcpPath);
  const servers = (mcp.mcpServers as Record<string, unknown>) ?? {};
  if (!servers["summon-agents"]) {
    servers["summon-agents"] = {
      command: "npx",
      args: ["-y", "summon-agents-mcp"],
    };
  }
  mcp.mcpServers = servers;
  await writeJson(mcpPath, mcp);

  process.stdout.write(
    "summon-agents: installed.\n" +
      `  hook:  ${settingsPath} (PostToolUse: ExitPlanMode)\n` +
      `  mcp:   ${mcpPath} (summon-agents)\n` +
      "  Approve a plan in plan mode and summon-agents will run.\n",
  );
}
