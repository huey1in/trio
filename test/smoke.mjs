// dsh-trio 冒烟测试:验证三个插件模块可加载、导出形状正确、工具定义合法。
// 运行:node test/smoke.mjs(无需 DSH 运行时)

import assert from "node:assert/strict";

const modules = {
  browser: await import("../src/browser.js"),
  mcp: await import("../src/mcp.js"),
  github: await import("../src/github.js"),
  console: await import("../src/console.js"),
};

for (const [key, mod] of Object.entries(modules)) {
  assert.equal(typeof mod.apply, "function", `${key}: apply is a function`);
  assert.ok(Array.isArray(mod.inject), `${key}: inject is an array`);
  assert.equal(typeof mod.name, "string", `${key}: name is a string`);
  console.log(`✓ ${key}: name=${mod.name} inject=[${mod.inject.join(",")}]`);
}

// MCP 工具表必须齐全
assert.ok(modules.mcp.MCP_TOOLS?.length >= 5, "mcp: MCP_TOOLS listed");
for (const tool of modules.mcp.MCP_TOOLS) {
  assert.equal(typeof tool.name, "string");
  assert.equal(typeof tool.description, "string");
  assert.equal(tool.inputSchema.type, "object");
}
console.log(`✓ mcp: ${modules.mcp.MCP_TOOLS.map((t) => t.name).join(", ")}`);

// GitHub 纯函数
import { createHmac } from "node:crypto";
const pr = modules.github.extractPrRef({
  pull_request: { number: 7, title: "t", body: "b", head: { ref: "feat", sha: "abc" }, base: { ref: "main" }, additions: 1, deletions: 2, changed_files: 1, draft: false },
  repository: { full_name: "owner/repo" },
});
assert.equal(pr.owner, "owner");
assert.equal(pr.number, 7);
const goodSig = `sha256=${createHmac("sha256", "secret").update("body").digest("hex")}`;
assert.equal(modules.github.verifySignature("body", goodSig, "secret"), true);
assert.equal(modules.github.verifySignature("body", `sha256=${"1".repeat(64)}`, "secret"), false);
assert.equal(modules.github.verifySignature("body", undefined, "secret"), false);
console.log("✓ github: extractPrRef / verifySignature");

// YAML patch 基本形状(纯文本检查,避免引入 yaml 依赖)
import { readFileSync } from "node:fs";
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
for (const id of ["trio-browser", "trio-mcp", "trio-github", "trio-console"]) {
  assert.ok(patch.includes(`id: ${id}`), `patch contains ${id}`);
}
assert.ok(patch.includes("dsh-trio/browser"));
assert.ok(patch.includes("dsh-trio/mcp"));
assert.ok(patch.includes("dsh-trio/github"));
assert.ok(patch.includes("dsh-trio/console"));
console.log("✓ cordis.patch.yml: four rows");

console.log("\n全部通过 ✅");
