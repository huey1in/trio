// dsh-reef · GitHub 集成
//
// 4 个只读 GitHub REST API 工具(github_repo / github_issues / github_pulls /
// github_pr)+ webhook 自动 PR 评审 + issue 自动修复闭环。写操作交给 agent
// 用 bash + gh CLI。凭证:通过 DSH credentials seam 解析 tokenEnv(默认
// GITHUB_TOKEN),找不到时回退读进程环境变量;webhook 用 HMAC-SHA256 签名
// 校验;评审由 ctx.llm 调用。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReefContext, WebRoute } from "../lib/types.js";
import type { GithubConfig } from "./types.js";
import { resolveConfig, type ConfigSchema } from "../lib/config.js";
import { registerTools } from "./tools.js";
import { sendText, sendJson, urlPath } from "../lib/http.js";
import { handleWebhook, verifySignature, extractPrRef, recentEvents } from "./webhook.js";
import { extractIssueRef } from "./autofix.js";
import { buildReviewPrompt } from "./review.js";
import { projectIssue, projectPr } from "./api.js";
import { registerModuleSettingsRoute, sectionOverrides } from "../lib/settings.js";
import { GITHUB_SETTING_FIELDS } from "./settings.js";

export type { GithubConfig } from "./types.js";
export { verifySignature, extractPrRef } from "./webhook.js";
export { extractIssueRef } from "./autofix.js";
export { buildReviewPrompt } from "./review.js";
export { projectIssue, projectPr } from "./api.js";
export { encodeProject } from "./api.js";

export const name = "reef-github";
export const inject = ["tools"];

const GITHUB_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  tokenEnv: { type: "string" },
  apiBase: { type: "string" },
  webhookPath: { type: "string" },
  webhookSecretEnv: { type: "string" },
  reviewModel: { type: "any" },
  reviewMaxDiffChars: { type: "number", min: 100 },
  autoReviewEvents: { type: "string[]" },
  reviewDedupe: { type: "boolean" },
  autoFixRepos: { type: "any" },
  autoFixLabels: { type: "string[]" },
  autoFixTimeoutMs: { type: "number", min: 1000 },
};

const DEFAULT_CONFIG = {
  tokenEnv: "GITHUB_TOKEN",
  apiBase: "https://api.github.com",
  webhookPath: "/reef/github/webhook",
  webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
  reviewModel: {}, // { provider, model } — 空则用 agent 默认模型
  reviewMaxDiffChars: 60000,
  autoReviewEvents: ["opened", "synchronize", "reopened"],
  // 评审去重:同一 PR 同一 head sha 只评审一次
  reviewDedupe: true,
  // issue 自动修复闭环:repo full_name → 本地仓库路径
  autoFixRepos: {}, // 例: { "owner/repo": "C:/path/to/repo" }
  autoFixLabels: [], // 非空时,只有带这些标签之一的 issue 才触发修复
  autoFixTimeoutMs: 600000,
};

function registerWebhook(ctx: ReefContext, config: GithubConfig): void {
  const webServer = ctx.get<{ register(route: WebRoute): () => void }>("webServer");
  if (webServer === undefined) return;
  const base = (config.webhookPath ?? "/reef/github/webhook").replace(/\/+$/, "");
  const dispose = webServer.register({
    kind: "exact",
    path: base,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const path = urlPath(req);
      if (path !== base) {
        sendText(res, 404, "not found");
        return;
      }
      if ((req.method ?? "GET") !== "POST") {
        sendText(res, 405, "method not allowed");
        return;
      }
      void handleWebhook(ctx, config, req, res).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    },
  });
  // 事件看板数据源:最近 webhook 事件(供面板展示)
  const eventsPath = `${base.replace(/\/webhook$/, "")}/events`;
  const disposeEvents = webServer.register({
    kind: "exact",
    path: eventsPath,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if ((req.method ?? "GET") !== "GET") {
        sendText(res, 405, "method not allowed");
        return;
      }
      sendJson(res, 200, { events: recentEvents });
    },
  });
  // 设置端点:面板 ⚙ 配置 GITHUB_TOKEN 与模块参数(写入凭据库/设置存储)。
  const disposeSettings = registerModuleSettingsRoute(
    ctx,
    base.replace(/\/webhook$/, ""),
    "github",
    GITHUB_SETTING_FIELDS,
    config.tokenEnv ?? "GITHUB_TOKEN",
    "GitHub",
  );
  ctx.effect(() => () => {
    try {
      dispose();
      disposeEvents();
      disposeSettings();
    } catch {
      /* ignore */
    }
  });
}

export function apply(ctx: ReefContext, rawConfig: Record<string, any>) {
  const resolved = resolveConfig("github", GITHUB_SCHEMA, DEFAULT_CONFIG, rawConfig) as GithubConfig;
  if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
  // 面板设置覆盖:启动时合并 restart 字段(webhookPath)。
  const ov = sectionOverrides("github", GITHUB_SETTING_FIELDS);
  const config: GithubConfig = { ...resolved };
  if (typeof ov.webhookPath === "string" && ov.webhookPath) config.webhookPath = ov.webhookPath;
  registerTools(ctx, config);
  registerWebhook(ctx, config);
  const systemPrompt = ctx.get<{
    section(section: { name: string; order?: number; text: string }): () => void;
  }>("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:github",
    order: 201,
    text: "GitHub 只读工具(github_repo / github_issues / github_pulls / github_pr)访问 GitHub REST API;公共仓库无需 token(匿名 60 次/小时),配置 GITHUB_TOKEN 后无此限制且可访问私有仓库。写操作(创建 issue/PR、评论、评审、合并)用 bash 配合 gh CLI(优先,UTF-8 安全)或 curl + GITHUB_TOKEN 完成。警告:Windows PowerShell 的 Invoke-RestMethod/Invoke-WebRequest 发含中文的 JSON body 会按 ISO-8859-1 编码变成乱码,必须用 [System.Text.Encoding]::UTF8.GetBytes($json) 传字节流,或改用 gh CLI;发布中文内容后回读一次校验无乱码,乱码立即删除重发。引用 PR/issue 时给出 #编号与链接。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
}
