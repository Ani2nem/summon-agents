import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git/worktree integration tests spawn real processes; keep timeouts generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["packages/*/src/**/*.test.ts"],
    // Force the detached-spawn fallback in tests: the launcher path is identical
    // apart from the tmux wrapper, and pinning it keeps the suite off a shared
    // tmux daemon (deterministic, no cross-test session leakage). Real tmux is
    // proven by the standalone smoke script, not the unit suite.
    env: { SUMMON_DISABLE_TMUX: "1" },
  },
});
