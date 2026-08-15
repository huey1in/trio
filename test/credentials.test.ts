import { describe, it, expect } from "vitest";
import { validateCredentialValue } from "../src/lib/credentials.js";

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
