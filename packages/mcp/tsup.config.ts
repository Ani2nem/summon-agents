import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node20",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
