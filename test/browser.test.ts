import { describe, it, expect } from "vitest";
import { profileConfig } from "../src/browser/index.js";
import { definePlainTool } from "../src/lib/tools.js";
import type { BrowserConfig } from "../src/browser/index.js";

describe("profileConfig", () => {
  const base: BrowserConfig = {
    channel: "auto",
    headless: true,
    profiles: {
      work: { userDataDir: "/w", channel: "msedge" },
      personal: { userDataDir: "/p", headless: false },
    },
  };

  it("未配置的 profile 名返回原配置", () => {
    expect(profileConfig(base, "default")).toEqual(base);
  });

  it("命名 profile 覆盖字段", () => {
    const work = profileConfig(base, "work");
    expect(work.userDataDir).toBe("/w");
    expect(work.channel).toBe("msedge");
    expect(work.headless).toBe(true); // 未覆盖字段保留
  });

  it("多字段覆盖", () => {
    const personal = profileConfig(base, "personal");
    expect(personal.userDataDir).toBe("/p");
    expect(personal.headless).toBe(false);
  });
});

describe("工具定义与配置一致性", () => {
  it("browser 工具定义保持注册兼容", () => {
    const tool = definePlainTool({
      name: "browser_open",
      description: "d",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: async () => ({}),
    });
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
