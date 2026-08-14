import { describe, it, expect } from "vitest";
import { encodeProject, extractMrRef, verifyToken, projectMr, projectIssue } from "../src/gitlab.js";
import { createHmac } from "node:crypto";

describe("encodeProject", () => {
  it("owner/repo 编码为 %2F", () => {
    expect(encodeProject("owner/repo")).toBe("owner%2Frepo");
  });
  it("普通名称不变", () => {
    expect(encodeProject("my-project")).toBe("my-project");
  });
});

describe("extractMrRef", () => {
  const payload = {
    object_kind: "merge_request",
    object_attributes: {
      iid: 5,
      title: "Add feature",
      description: "d",
      action: "open",
      state: "opened",
      source_branch: "feat",
      target_branch: "main",
      url: "https://gitlab.com/o/r/-/merge_requests/5",
    },
    project: { path_with_namespace: "o/r" },
  };

  it("提取 MR 引用", () => {
    const mr = extractMrRef(payload as any)!;
    expect(mr.project).toBe("o/r");
    expect(mr.iid).toBe(5);
    expect(mr.action).toBe("open");
    expect(mr.sourceBranch).toBe("feat");
  });

  it("非 MR payload 返回 undefined", () => {
    expect(extractMrRef({ object_kind: "push" } as any)).toBeUndefined();
    expect(extractMrRef({} as any)).toBeUndefined();
  });
});

describe("verifyToken", () => {
  const secret = "s3cret";
  it("正确 token 通过", () => {
    expect(verifyToken("body", secret, secret)).toBe(true);
  });
  it("错误 token 拒绝", () => {
    expect(verifyToken("body", "wrong", secret)).toBe(false);
  });
  it("缺失 token 拒绝", () => {
    expect(verifyToken("body", undefined, secret)).toBe(false);
  });
});

describe("projectMr / projectIssue", () => {
  it("投影 MR", () => {
    const out = projectMr({
      iid: 1,
      title: "T",
      state: "opened",
      author: { username: "u" },
      source_branch: "f",
      target_branch: "m",
      web_url: "https://x",
    });
    expect(out.iid).toBe(1);
    expect(out.source_branch).toBe("f");
  });

  it("投影 issue", () => {
    const out = projectIssue({
      iid: 2,
      title: "I",
      state: "opened",
      author: { username: "u" },
      labels: ["bug"],
      web_url: "https://x",
    });
    expect(out.iid).toBe(2);
    expect(out.labels).toEqual(["bug"]);
  });
});
