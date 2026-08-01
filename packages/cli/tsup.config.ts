import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node20",
  sourcemap: true,
  // CLI bin needs a shebang so it runs directly.
  banner: { js: "#!/usr/bin/env node" },
});
