import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateCredentialValue,
  readStoredToken,
  writeStoredToken,
  tokenStorePath,
} from "../src/lib/credentials.js";

describe("validateCredentialValue", () => {
  it("合法字符串原样返回", () => {
    expect(validateCredentialValue("ghp_abc123")).toBe("ghp_abc123");
  });

  it("空串表示清除", () => {
    expect(validateCredentialValue("")).toBe("");
  });

  it("非字符串拒绝", () => {
    expect(validateCredentialValue(123)).toEqual({ error: "value must be a string" });
    expect(validateCredentialValue(undefined)).toEqual({ error: "value must be a string" });
    expect(validateCredentialValue(null)).toEqual({ error: "value must be a string" });
  });

  it("超长值拒绝", () => {
    expect(validateCredentialValue("x".repeat(2001))).toEqual({ error: "value too long" });
    expect(validateCredentialValue("x".repeat(2000))).toBe("x".repeat(2000));
  });
});

describe("token 自有存储", () => {
  const tempHome = mkdtempSync(join(tmpdir(), "dsh-trio-tokens-"));
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

  it("路径落在 DSH_HOME/.dsh-trio 下", () => {
    expect(tokenStorePath()).toBe(join(tempHome, ".dsh-trio", "tokens.json"));
  });

  it("写入后可读回,空串清除", async () => {
    await writeStoredToken("GITHUB_TOKEN", "ghp_test");
    expect(await readStoredToken("GITHUB_TOKEN")).toBe("ghp_test");
    await writeStoredToken("GITHUB_TOKEN", "");
    expect(await readStoredToken("GITHUB_TOKEN")).toBeUndefined();
  });

  it("未写入的 ref 返回 undefined", async () => {
    expect(await readStoredToken("NO_SUCH_REF")).toBeUndefined();
  });
});
