import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser/index.ts",
    "src/mcp/index.ts",
    "src/github/index.ts",
    "src/gitlab/index.ts",
    "src/console.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: "lib",
});
