// claude.ts (CLI) - re-exports the shared agent adapter from core, plus the
// CLI-only plan resolver. The Judge/AgentRunner adapter itself lives in
// @summon-agents/core so the MCP server can reuse it.

import * as fs from "node:fs/promises";

export {
  type AgentCliConfig,
  type AgentVendor,
  agentConfigFromEnv,
  agentCommandBuilder,
  agentInteractiveCommandBuilder,
  agentJudge,
  agentAvailable,
  unsupportedVendorReason,
  normalizeVendor,
  parseTriageResponse,
  parseSessionId,
  resumeCommand,
} from "@summon-agents/core";

/** Read a plan from a file path, or return the string directly if not a file. */
export async function resolvePlan(planOrPath: string): Promise<string> {
  try {
    return await fs.readFile(planOrPath, "utf8");
  } catch {
    return planOrPath;
  }
}
