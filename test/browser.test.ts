import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfig } from "../src/browser/index.js";
import { cleanupScreenshots } from "../src/browser/session.js";
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

describe("cleanupScreenshots", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-reef-shot-"));
    dirs.push(dir);
    return dir;
  };
  const touch = (dir: string, name: string, ageMs: number) => {
    const file = join(dir, name);
    writeFileSync(file, "png");
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
    return file;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("删除超过保留天数的旧截图", () => {
    const dir = makeDir();
    touch(dir, "old.png", 8 * 86_400_000);
    touch(dir, "new.png", 1000);
    const removed = cleanupScreenshots(dir, { maxAgeDays: 7 });
    expect(removed).toBe(1);
    expect(() => cleanupScreenshots(dir, { maxAgeDays: 7 })).not.toThrow();
    expect(cleanupScreenshots(dir, { maxAgeDays: 7 })).toBe(0); // 幂等
  });

  it("超过数量上限时只保留最新的 N 个", () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i++) touch(dir, `shot-${i}.png`, i * 60_000);
    const removed = cleanupScreenshots(dir, { maxCount: 2 });
    expect(removed).toBe(3);
    // 剩下的应该是最新的两个(名字不是判断依据,这里只验证数量)
    const left = cleanupScreenshots(dir, { maxCount: 2 });
    expect(left).toBe(0);
  });

  it("忽略非 .png 文件与子目录", () => {
    const dir = makeDir();
    touch(dir, "keep.txt", 999 * 86_400_000);
    mkdirSync(join(dir, "sub"));
    touch(join(dir, "sub"), "inner.png", 999 * 86_400_000);
    const removed = cleanupScreenshots(dir, { maxAgeDays: 7 });
    expect(removed).toBe(0);
  });

  it("目录不存在或规则全为 0 时不清理", () => {
    expect(cleanupScreenshots(join(tmpdir(), "dsh-reef-no-such-dir-xyz"), { maxAgeDays: 7 })).toBe(0);
    const dir = makeDir();
    touch(dir, "a.png", 999 * 86_400_000);
    expect(cleanupScreenshots(dir, {})).toBe(0);
    expect(cleanupScreenshots(dir, { maxAgeDays: 0, maxCount: 0 })).toBe(0);
  });
});
