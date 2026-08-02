import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node20",
  sourcemap: true,
  // Bundle the workspace core into the published bin so it is self-contained
  // (no @summon-agents/core dependency for npm consumers). Third-party deps
  // (commander/execa/zod) stay external and are installed from npm.
  noExternal: ["@summon-agents/core"],
  // CLI bin needs a shebang so it runs directly.
  banner: { js: "#!/usr/bin/env node" },
});
