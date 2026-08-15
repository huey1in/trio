// dsh-reef · GitHub — webhook 处理器(签名校验、事件记录、路由分发)
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReefContext } from "../lib/types.js";
import type { GithubConfig, GithubEventEntry } from "./types.js";
import { readRawBody, sendJson } from "../lib/http.js";
import { sectionOverrides } from "../lib/settings.js";
import { GITHUB_SETTING_FIELDS } from "./settings.js";
import { reviewPullRequest } from "./review.js";
import { extractIssueRef } from "./autofix.js";
import { runAutoFix } from "./autofix.js";
export const recentEvents: GithubEventEntry[] = [];

export function recordEvent(event: string, action: string, payload: Record<string, any>, handled: boolean, detail: string): void {
  const repo = payload?.repository?.full_name ?? "";
  const number = payload?.pull_request?.number ?? payload?.issue?.number ?? payload?.number ?? null;
  recentEvents.push({
    ts: Date.now(),
    event,
    action,
    repo,
    number,
    title: payload?.pull_request?.title ?? payload?.issue?.title ?? "",
    handled: handled === true,
    detail: detail ?? "",
  });
  if (recentEvents.length > 50) recentEvents.shift();
}

/** 已评审的 PR(评审去重):key = owner/repo#number:headSha → ts。 */
const reviewedPrs = new Map();

const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 Pull Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件:行号 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------


export function verifySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractPrRef(payload: Record<string, any>): Record<string, any> | undefined {
  const pr = payload?.pull_request;
  const repo = payload?.repository;
  if (!pr || !repo?.full_name) return undefined;
  const [owner, repoName] = repo.full_name.split("/");
  return {
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    headSha: pr.head?.sha ?? "",
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    draft: pr.draft === true,
    htmlUrl: pr.html_url ?? "",
  };
}


export async function handleWebhook(ctx: ReefContext, config: GithubConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 面板设置覆盖:webhookSecret(优先于环境变量),每次请求读取即时生效。
  const ov = sectionOverrides("github", GITHUB_SETTING_FIELDS);
  const panelSecret = typeof ov.webhookSecret === "string" && ov.webhookSecret ? ov.webhookSecret : "";
  const envSecret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : undefined;
  const secret = panelSecret || envSecret;
  const rawBody = await readRawBody(req);
  if (secret) {
    const signature = req.headers["x-hub-signature-256"];
    if (!verifySignature(rawBody, String(signature ?? ""), secret)) {
      sendJson(res, 401, { error: "invalid signature" });
      return;
    }
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  const event = String(req.headers["x-github-event"] ?? "");
  const action = payload?.action ?? "";

  // issue 自动修复闭环:opened 且仓库已配置 autoFixRepos
  if (event === "issues" && action === "opened" && payload?.issue !== undefined && !payload.issue.pull_request) {
    const issue = extractIssueRef(payload);
    const fullName = issue ? `${issue.owner}/${issue.repo}` : "";
    if (issue !== undefined && config.autoFixRepos !== undefined && fullName in config.autoFixRepos) {
      recordEvent(event, action, payload, true, "auto-fix triggered");
      void (async () => {
        try {
          await runAutoFix(ctx, config, issue);
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-reef/github: auto-fix flow failed for ${fullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      sendJson(res, 202, { received: true, event, action, handled: true, autoFix: true, issue: issue.number });
      return;
    }
    recordEvent(event, action, payload, false, "repo not in autoFixRepos");
    sendJson(res, 200, { received: true, event, action, handled: false, reason: "repo not in autoFixRepos" });
    return;
  }

  const actionStr = String(action);
  // 面板覆盖:autoReviewEvents(逗号分隔,空 = 关闭);未覆盖时用 config。
  const reviewEvents =
    "autoReviewEvents" in ov
      ? String(ov.autoReviewEvents ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      : (config.autoReviewEvents ?? []);
  if (event !== "pull_request" || !reviewEvents.includes(actionStr)) {
    recordEvent(event, actionStr, payload, false, "not handled");
    sendJson(res, 200, { received: true, event, action: actionStr, handled: false });
    return;
  }
  const pr = extractPrRef(payload);
  if (!pr || pr.draft) {
    recordEvent(event, action, payload, false, "draft or missing pr");
    sendJson(res, 200, { received: true, event, action, handled: false, reason: "draft or missing pr" });
    return;
  }
  recordEvent(event, action, payload, true, "review queued");
  // 异步评审:立即返回 202,评审完成后评论到 PR。
  void (async () => {
    try {
      await reviewPullRequest(ctx, config, pr);
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-reef/github: webhook review failed for ${pr.owner}/${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  sendJson(res, 202, { received: true, event, action, handled: true, pr: pr.number });
}

