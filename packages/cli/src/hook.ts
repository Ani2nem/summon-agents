// hook.ts - read the approved plan from an editor hook payload on stdin.
//
// Fully implemented for Claude Code in the host-wiring task; other hosts parse
// their own payloads here behind the same interface. Returns the plan text when
// this is a *finalized* plan approval, or null to fail soft (exit 0) - never
// wedge the editor.

import { parseClaudeHookPlan } from "./hosts/claude.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readHookPlan(host: string): Promise<string | null> {
  const raw = await readStdin();
  switch (host) {
    case "claude-code":
      return parseClaudeHookPlan(raw);
    default:
      // Unknown host: fail soft.
      return null;
  }
}
