import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReefSettings,
  writeSettingsSection,
  sectionOverrides,
  validateFieldValue,
  type FieldSpec,
} from "../src/lib/settings.js";

const SPEC: FieldSpec[] = [
  { key: "headless", label: "无头", type: "boolean", defaultValue: true },
  { key: "channel", label: "通道", type: "enum", options: ["auto", "msedge", "chrome"], defaultValue: "auto" },
  { key: "timeoutMs", label: "超时", type: "number", defaultValue: 30000 },
  { key: "dir", label: "目录", type: "string", defaultValue: ".x" },
  { key: "secret", label: "密钥", type: "password", defaultValue: "" },
];

describe("settings 存储", () => {
  const tempHome = mkdtempSync(join(tmpdir(), "dsh-reef-settings-"));
  const prevHome = process.env.DSH_HOME;

  beforeAll(() => {
    process.env.DSH_HOME = tempHome;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("写入后可读回,空串清除覆盖", async () => {
    await writeSettingsSection("browser", { headless: false, timeoutMs: 9000, dir: "/tmp/x" }, SPEC);
    const ov = sectionOverrides("browser", SPEC);
    expect(ov.headless).toBe(false);
    expect(ov.timeoutMs).toBe(9000);
    expect(ov.dir).toBe("/tmp/x");
    await writeSettingsSection("browser", { dir: "" }, SPEC);
    const ov2 = sectionOverrides("browser", SPEC);
    expect("dir" in ov2).toBe(false);
    expect(ov2.headless).toBe(false); // 其他字段保留
  });

  it("非法类型整批拒绝", async () => {
    await expect(
      writeSettingsSection("browser", { headless: "yes" }, SPEC),
    ).rejects.toThrow(/must be a boolean/);
    await expect(
      writeSettingsSection("browser", { timeoutMs: "fast" }, SPEC),
    ).rejects.toThrow(/finite number/);
    await expect(
      writeSettingsSection("browser", { channel: "firefox" }, SPEC),
    ).rejects.toThrow(/must be one of/);
  });

  it("未知字段拒绝", async () => {
    await expect(
      writeSettingsSection("browser", { nope: 1 }, SPEC),
    ).rejects.toThrow(/unknown setting/);
  });

  it("存储里手工写入的非法值被 sectionOverrides 丢弃", async () => {
    // 直接污染存储文件
    await writeSettingsSection("browser", { headless: false }, SPEC);
    const fs = await import("node:fs");
    const path = join(tempHome, ".dsh-reef", "settings.json");
    const store = JSON.parse(fs.readFileSync(path, "utf8"));
    store.browser.headless = "corrupted";
    store.browser.unknownKey = "x";
    fs.writeFileSync(path, JSON.stringify(store));
    const ov = sectionOverrides("browser", SPEC);
    expect(ov.headless).toBeUndefined();
    expect(ov.unknownKey).toBeUndefined();
  });

  it("validateFieldValue 对数字字符串宽容", () => {
    expect(validateFieldValue(SPEC[2], "42")).toEqual({ ok: true, value: 42 });
    expect(validateFieldValue(SPEC[2], "abc")).toEqual({ ok: false, error: expect.stringContaining("number") });
  });

  it("readReefSettings 文件缺失返回空对象", () => {
    // 切到全新目录
    const other = mkdtempSync(join(tmpdir(), "dsh-reef-empty-"));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = other;
    try {
      expect(readReefSettings()).toEqual({});
    } finally {
      process.env.DSH_HOME = prev;
      try { rmSync(other, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
