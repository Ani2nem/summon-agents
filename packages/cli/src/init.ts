// init.ts - install the per-host trigger + MCP registration for a project.
//
// Trigger design (revised after the live M1 test): Claude Code's plan-mode hooks
// (PostToolUse:ExitPlanMode) do NOT reliably fire and run with the wrong cwd
// (upstream issues #15660/#20397/#22343), so the auto-fire-on-approval trigger is
// not viable there. The portable trigger is instead an explicit invocation:
//
//   - the host agent writes the approved plan to a gitignored temp file, then
//   - runs `summon-agents run --plan <file>` and does NOT implement it inline.
//
// Only the trigger *file format* differs per vendor. The instruction body below
// is shared, so Cursor (rules) and Copilot (prompts) in M2 reuse it verbatim.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The shared instruction body, vendor-agnostic. Every host's trigger file wraps
 * this in its own frontmatter/format. It drives the summon_agents MCP tool
 * (registered by this same init), which works uniformly across Claude Code,
 * Cursor, and Copilot - and forbids implementing inline (which is what raced
 * summon-agents in the live test).
 */
export const TRIGGER_BODY = `The user wants to execute the current approved implementation plan using summon-agents - parallel, isolated agents - and NOT by implementing it yourself.

Do exactly this:
1. Call the \`summon_agents\` tool (provided by the summon-agents MCP server), passing the full text of the most recently approved plan as the \`plan\` argument. If no plan has been approved yet, stop and ask the user to plan first.
2. Do NOT implement the plan yourself, and do NOT edit project files. summon_agents creates an isolated git worktree per task, runs an agent in each, merges them back locally (gated on a clean, validated merge), and opens a PR (or reports a manual PR command if there is no remote).
3. Relay the tool's final report to the user verbatim.`;

export interface HostFile {
  path: string;
  contents: string;
}

/** Claude Code: an explicit `/summon-agents` slash command. */
export function claudeCommandFile(repoRoot: string): HostFile {
  const contents = `---
description: Dispatch the approved plan to parallel summon-agents workers
allowed-tools: Bash, Write
---
${TRIGGER_BODY}
`;
  return {
    path: path.join(repoRoot, ".claude", "commands", "summon-agents.md"),
    contents,
  };
}

/** Cursor (M2): a rule the agent follows when asked to summon agents. */
export function cursorRuleFile(repoRoot: string): HostFile {
  const contents = `---
description: Dispatch the approved plan to parallel summon-agents workers
alwaysApply: false
---
${TRIGGER_BODY}
`;
  return {
    path: path.join(repoRoot, ".cursor", "rules", "summon-agents.mdc"),
    contents,
  };
}

/** GitHub Copilot (M2): a prompt file invocable from Copilot Chat. */
export function copilotPromptFile(repoRoot: string): HostFile {
  const contents = `---
mode: agent
description: Dispatch the approved plan to parallel summon-agents workers
---
${TRIGGER_BODY}
`;
  return {
    path: path.join(repoRoot, ".github", "prompts", "summon-agents.prompt.md"),
    contents,
  };
}

type Host = "claude-code" | "cursor" | "copilot";

const HOST_FILE: Record<Host, (repoRoot: string) => HostFile> = {
  "claude-code": claudeCommandFile,
  cursor: cursorRuleFile,
  copilot: copilotPromptFile,
};

/** VS Code uses `servers`; Claude Code and Cursor use `mcpServers`. */
function mcpConfig(host: Host): { file: string; key: string } {
  if (host === "copilot") return { file: ".vscode/mcp.json", key: "servers" };
  if (host === "cursor") return { file: ".cursor/mcp.json", key: "mcpServers" };
  return { file: ".mcp.json", key: "mcpServers" };
}

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

async function writeHostFile(f: HostFile): Promise<void> {
  await fs.mkdir(path.dirname(f.path), { recursive: true });
  await fs.writeFile(f.path, f.contents);
}

/** Register the MCP server (used by M2) in the host's config, merging in place. */
async function registerMcp(repoRoot: string, host: Host): Promise<string> {
  const { file, key } = mcpConfig(host);
  const full = path.join(repoRoot, file);
  const cfg = await readJson(full);
  const servers = (cfg[key] as Record<string, unknown>) ?? {};
  if (!servers["summon-agents"]) {
    servers["summon-agents"] = {
      command: "npx",
      args: ["-y", "summon-agents-mcp"],
    };
  }
  cfg[key] = servers;
  await writeJson(full, cfg);
  return full;
}

/** Ensure `.summon-agents/` is gitignored (it holds run state + the staged plan). */
async function ensureGitignore(repoRoot: string): Promise<void> {
  const gi = path.join(repoRoot, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gi, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (!current.split("\n").some((l) => l.trim() === ".summon-agents/")) {
    const next = current && !current.endsWith("\n") ? current + "\n" : current;
    await fs.writeFile(gi, next + ".summon-agents/\n");
  }
}

export async function runInit(repoRoot: string, host: string): Promise<void> {
  if (!(host in HOST_FILE)) {
    process.stdout.write(
      `summon-agents: unknown host "${host}" (expected: claude-code, cursor, copilot)\n`,
    );
    return;
  }
  const h = host as Host;

  const trigger = HOST_FILE[h](repoRoot);
  await writeHostFile(trigger);
  const mcpPath = await registerMcp(repoRoot, h);
  await ensureGitignore(repoRoot);

  const invoke =
    h === "claude-code"
      ? "/summon-agents"
      : h === "cursor"
        ? "the summon-agents rule (ask Cursor to \"summon agents\")"
        : "the summon-agents prompt (/summon-agents in Copilot Chat)";

  process.stdout.write(
    "summon-agents: installed.\n" +
      `  trigger: ${trigger.path}\n` +
      `  mcp:     ${mcpPath}\n` +
      `  Plan, then invoke ${invoke} to dispatch the plan to parallel agents.\n`,
  );
}
