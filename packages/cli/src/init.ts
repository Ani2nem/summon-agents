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
import * as os from "node:os";
import * as path from "node:path";

/**
 * The shared instruction body, vendor-agnostic. Every host's trigger file wraps
 * this in its own frontmatter/format. It drives the summon_agents MCP tool
 * (registered by this same init), which works uniformly across Claude Code,
 * Cursor, and Copilot - and forbids implementing inline (which is what raced
 * summon-agents in the live test).
 */
export const TRIGGER_BODY = `The user wants to execute an approved implementation plan using summon-agents - parallel, isolated agents - and NOT by implementing it yourself.

Do exactly this:
1. Identify WHICH plan to dispatch, in this priority order:
   a. If the user gave plan text with this command (or a pointer like "the plan above" / "the plan we just wrote"), use THAT.
   b. Otherwise use the plan the user most recently approved IN THIS CONVERSATION - the plan you just presented and they accepted. Use the conversation's plan, NOT a plan file on disk, unless the user explicitly points you to a file. (A stale plan file is the #1 cause of dispatching the wrong thing.)
   c. If you cannot identify a single, current plan with confidence, STOP and ask the user which plan to dispatch.
2. BEFORE calling the tool, show the user the exact plan you are about to dispatch - a one-line summary plus the concrete files/tasks it will create - and ask them to confirm. Do NOT call the tool until they confirm. This one check prevents dispatching a stale or wrong plan and wasting a full run.
3. Once confirmed, call the \`summon_agents\` tool (provided by the summon-agents MCP server) with that plan as the \`plan\` argument. Do NOT implement the plan yourself, and do NOT edit project files. summon_agents creates an isolated git worktree per task, runs an agent in each, merges them back locally (gated on a clean, validated merge), and opens a PR (or reports a manual PR command if there is no remote).
4. Relay the tool's final report to the user verbatim.`;

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

/** OpenAI Codex: a prompt trigger file under `.codex/prompts/`. */
export function codexPromptFile(repoRoot: string): HostFile {
  const contents = `---
description: Dispatch the approved plan to parallel summon-agents workers
---
${TRIGGER_BODY}
`;
  return {
    path: path.join(repoRoot, ".codex", "prompts", "summon-agents.md"),
    contents,
  };
}

type Host = "claude-code" | "cursor" | "copilot" | "codex";

const HOST_FILE: Record<Host, (repoRoot: string) => HostFile> = {
  "claude-code": claudeCommandFile,
  cursor: cursorRuleFile,
  copilot: copilotPromptFile,
  codex: codexPromptFile,
};

/**
 * Which vendor's agent CLI the workers should use for a given host. This is the
 * whole point of per-host init: summon from Cursor -> Cursor workers, from
 * Copilot -> Copilot workers, from Claude Code -> Claude workers. Baked into the
 * MCP registration below as SUMMON_AGENT_VENDOR so it is picked automatically.
 */
const HOST_VENDOR: Record<Host, string> = {
  "claude-code": "claude",
  cursor: "cursor",
  copilot: "copilot",
  codex: "codex",
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
  // Preserve any env the user added (e.g. SUMMON_AGENT_BIN), but always set the
  // vendor for this host so the correct worker CLI is spawned automatically.
  const existing = (servers["summon-agents"] as Record<string, unknown>) ?? {};
  const existingEnv = (existing.env as Record<string, string>) ?? {};
  servers["summon-agents"] = {
    command: "npx",
    args: ["-y", "summon-agents-mcp"],
    env: { ...existingEnv, SUMMON_AGENT_VENDOR: HOST_VENDOR[host] },
  };
  cfg[key] = servers;
  await writeJson(full, cfg);
  return full;
}

/**
 * Register the MCP server for Codex. EXPERIMENTAL - verify against the current
 * Codex config schema. Unlike the JSON-based hosts, Codex reads a GLOBAL TOML
 * file (`~/.codex/config.toml`) with `[mcp_servers.<name>]` tables, so this is a
 * separate path from `registerMcp`. Idempotent: skips if a
 * `[mcp_servers.summon-agents]` block already exists. The codex dir is resolved
 * from CODEX_HOME (falling back to ~/.codex) so tests can redirect it.
 */
async function registerCodexMcp(): Promise<string> {
  const codexDir =
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = path.join(codexDir, "config.toml");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    /* no config.toml yet */
  }
  if (current.includes("[mcp_servers.summon-agents]")) {
    return file;
  }
  const block = `[mcp_servers.summon-agents]
command = "npx"
args = ["-y", "summon-agents-mcp"]
env = { SUMMON_AGENT_VENDOR = "codex" }
`;
  const prefix = current && !current.endsWith("\n") ? current + "\n" : current;
  const next = prefix ? prefix + "\n" + block : block;
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(file, next);
  return file;
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
      `summon-agents: unknown host "${host}" (expected: claude-code, cursor, copilot, codex)\n`,
    );
    return;
  }
  const h = host as Host;

  const trigger = HOST_FILE[h](repoRoot);
  await writeHostFile(trigger);
  // Codex registers its MCP server in a global TOML file, not a per-repo JSON.
  const mcpPath =
    h === "codex" ? await registerCodexMcp() : await registerMcp(repoRoot, h);
  await ensureGitignore(repoRoot);

  const invoke =
    h === "claude-code"
      ? "/summon-agents"
      : h === "cursor"
        ? "the summon-agents rule (ask Cursor to \"summon agents\")"
        : h === "copilot"
          ? "the summon-agents prompt (/summon-agents in Copilot Chat)"
          : "the summon-agents prompt (/summon-agents in Codex)";

  const workerCli = {
    "claude-code": "claude (Claude Code CLI)",
    cursor: "cursor-agent (Cursor CLI)",
    copilot: "copilot (GitHub Copilot CLI)",
    codex: "codex (OpenAI Codex CLI)",
  }[h];

  process.stdout.write(
    "summon-agents: installed.\n" +
      `  trigger: ${trigger.path}\n` +
      `  mcp:     ${mcpPath}\n` +
      `  workers: ${workerCli} - must be installed and on your PATH\n` +
      `  Plan, then invoke ${invoke} to dispatch the plan to parallel agents.\n`,
  );
}
