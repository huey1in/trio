// dsh-reef · GitLab — webhook 自动 MR 评审
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReefContext } from "../lib/types.js";
import type { GitlabConfig } from "./types.js";
import { runLlm } from "../lib/llm.js";
import { readRawBody, sendJson } from "../lib/http.js";
import { sectionOverrides } from "../lib/settings.js";
import { GITLAB_SETTING_FIELDS } from "./settings.js";
import { glFetch, encodeProject } from "./api.js";
const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 GitLab Merge Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;

export function verifyToken(rawBody: string, headerToken: string | undefined, secret: string): boolean {
  if (!headerToken) return false;
  const a = Buffer.from(String(headerToken));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractMrRef(payload: Record<string, any>): Record<string, any> | undefined {
  const attrs = payload?.object_attributes;
  const project = payload?.project;
  if (!attrs || !project?.path_with_namespace) return undefined;
  return {
    project: project.path_with_namespace,
    iid: attrs.iid,
    title: attrs.title ?? "",
    description: attrs.description ?? "",
    action: attrs.action ?? "",
    state: attrs.state ?? "",
    sourceBranch: attrs.source_branch ?? "",
    targetBranch: attrs.target_branch ?? "",
    url: attrs.url ?? "",
  };
}

export function buildMrReviewPrompt(mr: Record<string, any>, changes: Record<string, any>[]): string {
  const head = `# MR !${mr.iid} ${mr.title}\n\n${mr.description ?? ""}\n\n分支:${mr.targetBranch} ← ${mr.sourceBranch}\n`;
  const diffs = (changes ?? [])
    .map((file) => {
      const diff = file.diff ?? "(无 diff)";
      return `### ${file.new_path ?? file.old_path ?? "?"}\n\`\`\`diff\n${diff}\n\`\`\``;
    })
    .join("\n\n");
  return `${head}\n\n${diffs}`;
}

export async function handleWebhook(ctx: ReefContext, config: GitlabConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 面板设置覆盖:webhookSecret(优先于环境变量),每次请求读取即时生效。
  const ov = sectionOverrides("gitlab", GITLAB_SETTING_FIELDS);
  const panelSecret = typeof ov.webhookSecret === "string" && ov.webhookSecret ? ov.webhookSecret : "";
  const envSecret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : undefined;
  const secret = panelSecret || envSecret;
  const rawBody = await readRawBody(req);
  if (secret) {
    const token = req.headers["x-gitlab-token"];
    if (!verifyToken(rawBody, String(token ?? ""), secret)) {
      sendJson(res, 401, { error: "invalid token" });
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
  const mr = extractMrRef(payload);
  // 面板覆盖:autoReviewEvents(逗号分隔,空 = 关闭);未覆盖时用 config。
  const reviewEvents =
    "autoReviewEvents" in ov
      ? String(ov.autoReviewEvents ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      : (config.autoReviewEvents ?? []);
  if (
    payload?.object_kind !== "merge_request" ||
    mr === undefined ||
    mr.state !== "opened" ||
    !reviewEvents.includes(mr.action)
  ) {
    sendJson(res, 200, { received: true, handled: false, reason: "not a reviewable MR event" });
    return;
  }
  void (async () => {
    try {
      const project = encodeProject(mr.project);
      const detail = await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}`);
      const changes = await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}/changes`);
      const prompt = buildMrReviewPrompt(mr, changes?.changes ?? []);
      // 面板设置覆盖:reviewModelProvider/reviewModelModel。
      const model: Record<string, any> = { ...(config.reviewModel ?? {}) };
      if (typeof ov.reviewModelProvider === "string" && ov.reviewModelProvider) model.provider = ov.reviewModelProvider;
      if (typeof ov.reviewModelModel === "string" && ov.reviewModelModel) model.model = ov.reviewModelModel;
      const aborted = new AbortController();
      const timer = setTimeout(() => aborted.abort(), 60000);
      try {
        const review = await runLlm(
          ctx,
          model,
          REVIEW_SYSTEM_PROMPT,
          prompt.slice(0, config.reviewMaxDiffChars),
          aborted.signal,
          { maxTokens: 2000 },
        );
        if (!review) throw new Error("empty review output");
        await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}/notes`, {
          method: "POST",
          body: { body: `🤖 dsh-reef 自动评审\n\n${review.slice(0, 60000)}` },
        });
        ctx.logger?.info?.(`dsh-reef/gitlab: reviewed ${mr.project}!${mr.iid}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-reef/gitlab: webhook review failed for ${mr.project}!${mr.iid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  sendJson(res, 202, { received: true, handled: true, mr: mr.iid });
}

