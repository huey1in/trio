// dsh-trio · GitLab 集成
//
// 3 个只读 GitLab REST API 工具:
//   gitlab_project / gitlab_issues / gitlab_mr_list
// + webhook 自动 MR 评审(X-Gitlab-Token 校验,评审结果以 note 提交)。
// 写操作(建 issue/MR、评论)交给 agent 用 bash + glab CLI。
//
// 凭证:DSH credentials 或环境变量中的 tokenEnv(默认 GITLAB_TOKEN),
// 通过 PRIVATE-TOKEN header 发送。project 参数接受 "owner/repo" 形式。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import type { GitlabConfig } from "./types.js";
import { resolveConfig, type ConfigSchema } from "../lib/config.js";
import { registerTools } from "./tools.js";
import { handleWebhook, extractMrRef, verifyToken } from "./webhook.js";
import { encodeProject, projectMr, projectIssue } from "./api.js";
import { sendText, sendJson, urlPath } from "../lib/http.js";
import { registerCredentialSettings } from "../lib/credentials.js";

export type { GitlabConfig } from "./types.js";
export { extractMrRef, verifyToken } from "./webhook.js";
export { encodeProject, projectMr, projectIssue } from "./api.js";

export const name = "trio-gitlab";
export const inject = ["tools"];

const GITLAB_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  tokenEnv: { type: "string" },
  apiBase: { type: "string" },
  webhookPath: { type: "string" },
  webhookSecretEnv: { type: "string" },
  reviewModel: { type: "any" },
  reviewMaxDiffChars: { type: "number", min: 100 },
  autoReviewEvents: { type: "string[]" },
};

const DEFAULT_CONFIG = {
  tokenEnv: "GITLAB_TOKEN",
  apiBase: "https://gitlab.com/api/v4",
  webhookPath: "/trio/gitlab/webhook",
  webhookSecretEnv: "GITLAB_WEBHOOK_SECRET",
  reviewModel: {}, // { provider, model } — 空则用 agent 默认模型
  reviewMaxDiffChars: 60000,
  autoReviewEvents: ["open", "update", "reopen"],
};


function registerWebhook(ctx: TrioContext, config: GitlabConfig): void {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = (config.webhookPath ?? '/trio/gitlab/webhook').replace(/\/+$/, "");
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
  // 凭据设置端点:面板里配置 GITLAB_TOKEN(写入 DSH credentials 库)。
  const disposeSettings = registerCredentialSettings(
    ctx,
    base.replace(/\/webhook$/, ""),
    config.tokenEnv ?? "GITLAB_TOKEN",
    "GitLab",
  );
  ctx.effect(() => () => {
    try {
      dispose();
      disposeSettings();
    } catch {
      /* ignore */
    }
  });
}

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("gitlab", GITLAB_SCHEMA, DEFAULT_CONFIG, rawConfig) as GitlabConfig;
  const tools = ctx.get("tools");
  if (tools === undefined) return;
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  registerTools(ctx, config);
  registerWebhook(ctx, config);
  const systemPrompt = ctx.get("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:gitlab",
    order: 202,
    text: "GitLab 只读工具(gitlab_project / gitlab_issues / gitlab_mr_list)通过 GITLAB_TOKEN 访问 GitLab REST API。写操作(创建 issue/MR、评论)用 bash 配合 glab CLI 或 curl + GITLAB_TOKEN 完成。引用 issue/MR 时给出 !编号与链接。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
}


