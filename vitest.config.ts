import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git/worktree integration tests spawn real processes; keep timeouts generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["packages/*/src/**/*.test.ts"],
  },
});
