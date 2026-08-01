import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Use a non-composite tsconfig for dts generation (tsup's dts build does not
  // work with composite project references; tsc -b still uses tsconfig.json).
  dts: { tsconfig: "tsconfig.tsup.json" },
  tsconfig: "tsconfig.tsup.json",
  clean: true,
  target: "node20",
  sourcemap: true,
});
