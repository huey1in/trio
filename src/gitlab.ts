// dsh-trio · GitLab 集成
//
// 零依赖 GitLab REST API 工具集:
//   gitlab_project / gitlab_issues / gitlab_issue_create / gitlab_issue_comment /
//   gitlab_mr_list / gitlab_mr_create / gitlab_mr_inline_comment
// + webhook 自动 MR 评审(X-Gitlab-Token 校验,评审结果以 note 提交)。
//
// 凭证:DSH credentials 或环境变量中的 tokenEnv(默认 GITLAB_TOKEN),
// 通过 PRIVATE-TOKEN header 发送。project 参数接受 "owner/repo" 形式。

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "./lib/types.js";
import { definePlainTool, genericCard } from "./lib/tools.js";
import { runLlm } from "./lib/llm.js";
import { readRawBody, sendJson, sendText, urlPath } from "./lib/http.js";
import { resolveConfig, type ConfigSchema } from "./lib/config.js";

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

/** GitLab 模块配置。 */
export interface GitlabConfig {
  enabled?: boolean;
  tokenEnv?: string;
  apiBase?: string;
  webhookPath?: string;
  webhookSecretEnv?: string;
  reviewModel?: Record<string, any>;
  reviewMaxDiffChars?: number;
  autoReviewEvents?: string[];
}

const DEFAULT_CONFIG = {
  tokenEnv: "GITLAB_TOKEN",
  apiBase: "https://gitlab.com/api/v4",
  webhookPath: "/trio/gitlab/webhook",
  webhookSecretEnv: "GITLAB_WEBHOOK_SECRET",
  reviewModel: {}, // { provider, model } — 空则用 agent 默认模型
  reviewMaxDiffChars: 60000,
  autoReviewEvents: ["open", "update", "reopen"],
};

const REVIEW_SYSTEM_PROMPT = `你是资深代码评审员。请审阅下面这个 GitLab Merge Request 的变更,输出简洁的中文评审意见,格式:
## 总结
(2-4 句总体评价)
## 问题(按严重程度排序)
- [P0/P1/P2] 文件 — 问题与修改建议
## 亮点
(如有)
不要奉承,不要输出空话。只针对 diff 中真实存在的内容。`;

async function resolveToken(ctx: TrioContext, config: GitlabConfig): Promise<string | undefined> {
  try {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(config.tokenEnv);
      if (resolved?.value) return resolved.value;
    }
  } catch {
    /* fall through to env */
  }
  return config.tokenEnv ? (process.env[config.tokenEnv] ?? undefined) : undefined;
}

/** "owner/repo" → URL 编码的 project id(owner%2Frepo)。 */
function encodeProject(project: string): string {
  return encodeURIComponent(String(project));
}

async function glFetch(ctx: TrioContext, config: GitlabConfig, pathname: string, options: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  const token = await resolveToken(ctx, config);
  if (!token) {
    throw new Error(
      `GitLab token not configured: set env ${config.tokenEnv} (or via DSH credentials).`,
    );
  }
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": token,
    "user-agent": "dsh-trio",
  };
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  const retries = options.method === "GET" ? 2 : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`${config.apiBase}${pathname}`, {
        method: options.method ?? "GET",
        headers,
        body,
        signal,
      });
      if (attempt < retries && response.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      break;
    } catch (error) {
      if (attempt < retries && signal?.aborted !== true) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(
      `GitLab API ${response.status} for ${pathname}: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }
  return data;
}

export function projectIssue(issue: Record<string, any>) {
  return {
    iid: issue.iid,
    title: issue.title,
    state: issue.state,
    user: issue.author?.username ?? "",
    labels: issue.labels ?? [],
    created_at: issue.created_at,
    web_url: issue.web_url ?? "",
  };
}

export function projectMr(mr: Record<string, any>) {
  return {
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    user: mr.author?.username ?? "",
    source_branch: mr.source_branch ?? "",
    target_branch: mr.target_branch ?? "",
    merged_at: mr.merged_at ?? null,
    web_url: mr.web_url ?? "",
  };
}

function registerTools(ctx: TrioContext, config: GitlabConfig) {
  const tools = ctx.get("tools");
  if (tools === undefined) return;

  tools.register(
    definePlainTool({
      name: "gitlab_project",
      description: "获取 GitLab 项目信息(名称、星标、fork、open issues、默认分支)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
        },
        required: ["project"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          stars: { type: "integer" },
          forks: { type: "integer" },
          open_issues: { type: "integer" },
          default_branch: { type: "string" },
          web_url: { type: "string" },
        },
        required: ["name", "path", "stars", "forks", "open_issues", "default_branch", "web_url"],
      },
      render: (_args, value) =>
        `${value.path} ⭐${value.stars} 🍴${value.forks} issues:${value.open_issues} default:${value.default_branch}`,
      presentCall: (args) => genericCard("gitlab", String(args.project), String(args.project)),
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await glFetch(ctx, config, `/projects/${encodeProject(args.project)}`);
        return {
          name: data.name ?? "",
          path: data.path_with_namespace ?? "",
          stars: data.star_count ?? 0,
          forks: data.forks_count ?? 0,
          open_issues: data.open_issues_count ?? 0,
          default_branch: data.default_branch ?? "",
          web_url: data.web_url ?? "",
        };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_issues",
      description: "列出 GitLab 项目的 issue(state 默认 opened)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          state: { type: "string", enum: ["opened", "closed", "all"] },
          limit: { type: "integer" },
        },
        required: ["project"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          issues: { type: "array", items: { type: "object" } },
        },
        required: ["issues"],
      },
      render: (_args, value) =>
        value.issues
          .map((i: any) => `!${i.iid} [${i.state}] ${i.title} (${i.user})`)
          .join("\n") || "(no issues)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
        const state = args.state === "closed" ? "closed" : args.state === "all" ? "all" : "opened";
        const data = await glFetch(
          ctx,
          config,
          `/projects/${encodeProject(args.project)}/issues?state=${state}&per_page=${limit}`,
        );
        return { issues: (data ?? []).map(projectIssue) };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_issue_create",
      description: "在 GitLab 项目中创建 issue。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["project", "title"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iid: { type: "integer" },
          web_url: { type: "string" },
        },
        required: ["iid", "web_url"],
      },
      render: (_args, value) => `Created !${value.iid}: ${value.web_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await glFetch(ctx, config, `/projects/${encodeProject(args.project)}/issues`, {
          method: "POST",
          body: { title: args.title, description: args.body ?? "" },
        });
        return { iid: data.iid ?? 0, web_url: data.web_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_issue_comment",
      description: "在 GitLab issue 或 MR 上发布评论(note)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          iid: { type: "integer", description: "issue 或 MR 的 iid。" },
          body: { type: "string" },
        },
        required: ["project", "iid", "body"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          web_url: { type: "string" },
        },
        required: ["id", "web_url"],
      },
      render: (_args, value) => `Commented: ${value.web_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await glFetch(
          ctx,
          config,
          `/projects/${encodeProject(args.project)}/issues/${args.iid}/notes`,
          {
            method: "POST",
            body: { body: args.body },
          },
        );
        return { id: data.id ?? 0, web_url: data.web_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_mr_list",
      description: "列出 GitLab 项目的 Merge Request(state 默认 opened)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          state: { type: "string", enum: ["opened", "closed", "merged", "all"] },
          limit: { type: "integer" },
        },
        required: ["project"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mrs: { type: "array", items: { type: "object" } },
        },
        required: ["mrs"],
      },
      render: (_args, value) =>
        value.mrs
          .map((m: any) => `!${m.iid} [${m.state}] ${m.title} (${m.user}) ${m.source_branch}→${m.target_branch}`)
          .join("\n") || "(no merge requests)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
        const state = args.state ?? "opened";
        const data = await glFetch(
          ctx,
          config,
          `/projects/${encodeProject(args.project)}/merge_requests?state=${state}&per_page=${limit}`,
        );
        return { mrs: (data ?? []).map(projectMr) };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_mr_inline_comment",
      description: "在 MR 的 diff 上发一条行内讨论评论。path 为文件路径,line 为新增行号(new_line)。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          iid: { type: "integer", description: "MR 的 iid。" },
          body: { type: "string" },
          path: { type: "string", description: "评论针对的文件路径。" },
          line: { type: "integer", description: "新增行号(new_line)。" },
        },
        required: ["project", "iid", "body", "path", "line"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          web_url: { type: "string" },
        },
        required: ["id", "web_url"],
      },
      render: (_args, value) => `Inline comment: ${value.web_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const project = encodeProject(args.project);
        const mr = await glFetch(ctx, config, `/projects/${project}/merge_requests/${args.iid}`);
        const refs = mr.diff_refs ?? {};
        const data = await glFetch(
          ctx,
          config,
          `/projects/${project}/merge_requests/${args.iid}/discussions`,
          {
            method: "POST",
            body: {
              body: args.body,
              position: {
                position_type: "text",
                new_path: args.path,
                new_line: args.line,
                base_sha: refs.base_sha ?? "",
                start_sha: refs.start_sha ?? "",
                head_sha: refs.head_sha ?? "",
              },
            },
          },
        );
        const note = data.notes?.[0] ?? data;
        return { id: note.id ?? 0, web_url: note.url ?? note.web_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "gitlab_mr_create",
      description: "从 source_branch 向 target_branch 创建 Merge Request。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目路径,如 'owner/repo'。" },
          source_branch: { type: "string" },
          target_branch: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["project", "source_branch", "target_branch", "title"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iid: { type: "integer" },
          web_url: { type: "string" },
        },
        required: ["iid", "web_url"],
      },
      render: (_args, value) => `MR !${value.iid}: ${value.web_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await glFetch(
          ctx,
          config,
          `/projects/${encodeProject(args.project)}/merge_requests`,
          {
            method: "POST",
            body: {
              source_branch: args.source_branch,
              target_branch: args.target_branch,
              title: args.title,
              description: args.description ?? "",
            },
          },
        );
        return { iid: data.iid ?? 0, web_url: data.web_url ?? "" };
      },
    }),
  );
}

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

function buildMrReviewPrompt(mr: Record<string, any>, changes: Record<string, any>[]): string {
  const head = `# MR !${mr.iid} ${mr.title}\n\n${mr.description ?? ""}\n\n分支:${mr.targetBranch} ← ${mr.sourceBranch}\n`;
  const diffs = (changes ?? [])
    .map((file) => {
      const diff = file.diff ?? "(无 diff)";
      return `### ${file.new_path ?? file.old_path ?? "?"}\n\`\`\`diff\n${diff}\n\`\`\``;
    })
    .join("\n\n");
  return `${head}\n\n${diffs}`;
}

async function handleWebhook(ctx: TrioContext, config: GitlabConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : undefined;
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
  if (
    payload?.object_kind !== "merge_request" ||
    mr === undefined ||
    mr.state !== "opened" ||
    !(config.autoReviewEvents ?? []).includes(mr.action)
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
      const aborted = new AbortController();
      const timer = setTimeout(() => aborted.abort(), 60000);
      try {
        const review = await runLlm(
          ctx,
          config.reviewModel,
          REVIEW_SYSTEM_PROMPT,
          prompt.slice(0, config.reviewMaxDiffChars),
          aborted.signal,
          { maxTokens: 2000 },
        );
        if (!review) throw new Error("empty review output");
        await glFetch(ctx, config, `/projects/${project}/merge_requests/${mr.iid}/notes`, {
          method: "POST",
          body: { body: `🤖 dsh-trio 自动评审\n\n${review.slice(0, 60000)}` },
        });
        ctx.logger?.info?.(`dsh-trio/gitlab: reviewed ${mr.project}!${mr.iid}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-trio/gitlab: webhook review failed for ${mr.project}!${mr.iid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  sendJson(res, 202, { received: true, handled: true, mr: mr.iid });
}

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
  ctx.effect(() => () => {
    try {
      dispose();
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
    text: "GitLab 工具(gitlab_project / gitlab_issues / gitlab_issue_create / gitlab_issue_comment / gitlab_mr_list / gitlab_mr_create / gitlab_mr_inline_comment)通过 GITLAB_TOKEN 访问 GitLab REST API。引用 issue/MR 时给出 !编号与链接。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
}

export { encodeProject };
