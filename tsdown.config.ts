import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser.ts",
    "src/mcp.ts",
    "src/github.ts",
    "src/gitlab.ts",
    "src/console.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: "lib",
});
