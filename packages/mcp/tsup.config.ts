import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node20",
  sourcemap: true,
  // Bundle the workspace core into the published bin so it is self-contained.
  // Third-party deps (@modelcontextprotocol/sdk/execa/zod) stay external.
  noExternal: ["@summon-agents/core"],
  banner: { js: "#!/usr/bin/env node" },
});
