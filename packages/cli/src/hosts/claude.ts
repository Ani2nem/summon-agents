// hosts/claude.ts - Claude Code hook payload adapter.
//
// The trigger is plan approval. In Claude Code, approving a plan runs the
// ExitPlanMode tool; a PostToolUse hook matched to ExitPlanMode fires *after*
// the tool is permitted and executed - i.e. after the user approved. The
// propose stage (PreToolUse / permission request) is deliberately NOT used, so
// we never fork worktrees off an unapproved plan.
//
// Everything here fails soft: any shape we do not recognize returns null, and
// the caller exits 0 so a Claude Code update can never wedge the editor.

import { z } from "zod";

/** Tolerant schema for the PostToolUse payload we care about. */
const HookPayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();

/**
 * Return the approved plan text if this payload is a finalized ExitPlanMode
 * approval, else null. Exported for direct unit testing.
 */
export function extractApprovedPlan(payload: unknown): string | null {
  const parsed = HookPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data;

  // Must be the post-execution event for the plan-exit tool.
  if (p.hook_event_name && p.hook_event_name !== "PostToolUse") return null;
  if (p.tool_name && p.tool_name !== "ExitPlanMode") return null;

  const plan = p.tool_input?.["plan"];
  if (typeof plan === "string" && plan.trim().length > 0) return plan;

  // Some payload variants may carry the plan under a different key; be lenient
  // but require *some* non-empty plan text rather than firing on nothing.
  const message = p.tool_input?.["message"];
  if (typeof message === "string" && message.trim().length > 0) return message;

  return null;
}

/** Parse raw stdin JSON into an approved plan, or null to fail soft. */
export function parseClaudeHookPlan(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  return extractApprovedPlan(json);
}
