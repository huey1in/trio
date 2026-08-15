import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser/index.ts",
    mcp: "src/mcp/index.ts",
    github: "src/github/index.ts",
    gitlab: "src/gitlab/index.ts",
    console: "src/console.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: "lib",
});
