import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySignature,
  extractPrRef,
  extractIssueRef,
  buildReviewPrompt,
  projectIssue,
  projectPr,
} from "../src/github/index.js";

describe("verifySignature", () => {
  const secret = "top-secret";
  const good = `sha256=${createHmac("sha256", secret).update("payload").digest("hex")}`;

  it("合法签名通过", () => {
    expect(verifySignature("payload", good, secret)).toBe(true);
  });

  it("错误签名拒绝", () => {
    expect(verifySignature("payload", `sha256=${"1".repeat(64)}`, secret)).toBe(false);
  });

  it("缺失签名拒绝", () => {
    expect(verifySignature("payload", undefined, secret)).toBe(false);
  });

  it("空 secret 且空签名拒绝", () => {
    expect(verifySignature("", undefined, "")).toBe(false);
  });
});

describe("extractPrRef", () => {
  const payload = {
    pull_request: {
      number: 42,
      title: "Fix thing",
      body: "desc",
      draft: false,
      head: { ref: "feature/x", sha: "abc123" },
      base: { ref: "main" },
      additions: 10,
      deletions: 2,
      changed_files: 3,
    },
    repository: { full_name: "owner/repo" },
  };

  it("提取 PR 引用", () => {
    const pr = extractPrRef(payload as any)!;
    expect(pr.owner).toBe("owner");
    expect(pr.repo).toBe("repo");
    expect(pr.number).toBe(42);
    expect(pr.headSha).toBe("abc123");
    expect(pr.draft).toBe(false);
  });

  it("缺失字段返回 undefined", () => {
    expect(extractPrRef({} as any)).toBeUndefined();
    expect(extractPrRef({ pull_request: {} } as any)).toBeUndefined();
  });
});

describe("extractIssueRef", () => {
  it("提取 issue 引用与标签", () => {
    const issue = extractIssueRef({
      repository: { full_name: "o/r" },
      issue: { number: 7, title: "Bug", body: "b", labels: [{ name: "bug" }] },
    } as any)!;
    expect(issue.number).toBe(7);
    expect(issue.labels[0].name).toBe("bug");
  });
});

describe("buildReviewPrompt", () => {
  it("包含 PR 元信息与 diff", () => {
    const prompt = buildReviewPrompt(
      { number: 1, title: "T", body: "B", base: { ref: "main" }, head: { ref: "f" }, additions: 1, deletions: 2, changed_files: 1 },
      [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: "+1" }],
    );
    expect(prompt).toContain("# PR #1 T");
    expect(prompt).toContain("a.js");
    expect(prompt).toContain("+1");
  });

  it("二进制文件无 patch 时降级", () => {
    const prompt = buildReviewPrompt(
      { number: 1, title: "T", body: "", base: { ref: "m" }, head: { ref: "f" }, additions: 0, deletions: 0, changed_files: 1 },
      [{ filename: "x.bin", status: "added", additions: 0, deletions: 0 }],
    );
    expect(prompt).toContain("无 patch");
  });
});

describe("projectIssue / projectPr", () => {
  it("投影 issue 安全字段", () => {
    const out = projectIssue({
      number: 1,
      title: "T",
      state: "open",
      user: { login: "u" },
      labels: [{ name: "bug" }],
      comments: 3,
      created_at: "2026-01-01",
      html_url: "https://x",
    });
    expect(out.number).toBe(1);
    expect(out.labels).toEqual(["bug"]);
    expect(out.user).toBe("u");
  });

  it("投影 PR 字段", () => {
    const out = projectPr({
      number: 1,
      title: "T",
      state: "open",
      merged: false,
      head: { ref: "f" },
      base: { ref: "m" },
      additions: 5,
      deletions: 1,
      changed_files: 2,
    });
    expect(out.head).toBe("f");
    expect(out.additions).toBe(5);
  });
});
