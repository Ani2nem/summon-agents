// notifier.ts - a stdout Notifier for the CLI. Under the hook, stdout is the
// user-visible channel; keep it concise and scannable.

import type { AgentResult, Notifier, RunState } from "@summon-agents/core";

export function stdoutNotifier(): Notifier {
  return {
    info(message: string) {
      process.stdout.write(`summon-agents: ${message}\n`);
    },
    agentDone(result: AgentResult) {
      const mark = result.status === "success" ? "✓" : "✗";
      process.stdout.write(
        `  ${mark} ${result.slug} (${result.status}${
          result.summary ? `: ${result.summary}` : ""
        })\n`,
      );
    },
    runDone(_state: RunState, summary: string) {
      process.stdout.write(`summon-agents: done - ${summary}\n`);
    },
  };
}
