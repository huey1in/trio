// dsh-trio · GitLab 集成
//
// 零依赖 GitLab REST API 工具集:
//   gitlab_project / gitlab_issues / gitlab_issue_create / gitlab_issue_comment /
//   gitlab_mr_list / gitlab_mr_create
//
// 凭证:DSH credentials 或环境变量中的 tokenEnv(默认 GITLAB_TOKEN),
// 通过 PRIVATE-TOKEN header 发送。project 参数接受 "owner/repo" 形式。

import { definePlainTool, genericCard } from "./lib/tools.js";

export const name = "trio-gitlab";
export const inject = ["tools"];

const DEFAULT_CONFIG = {
  tokenEnv: "GITLAB_TOKEN",
  apiBase: "https://gitlab.com/api/v4",
};

async function resolveToken(ctx, config) {
  try {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(config.tokenEnv);
      if (resolved?.value) return resolved.value;
    }
  } catch {
    /* fall through to env */
  }
  return process.env[config.tokenEnv] ?? undefined;
}

/** "owner/repo" → URL 编码的 project id(owner%2Frepo)。 */
function encodeProject(project) {
  return encodeURIComponent(String(project));
}

async function glFetch(ctx, config, pathname, options = {}, signal) {
  const token = await resolveToken(ctx, config);
  if (!token) {
    throw new Error(
      `GitLab token not configured: set env ${config.tokenEnv} (or via DSH credentials).`,
    );
  }
  const headers = {
    "PRIVATE-TOKEN": token,
    "user-agent": "dsh-trio",
  };
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${config.apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body,
    signal,
  });
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

function projectIssue(issue) {
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

function projectMr(mr) {
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

function registerTools(ctx, config) {
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
          .map((i) => `!${i.iid} [${i.state}] ${i.title} (${i.user})`)
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
          .map((m) => `!${m.iid} [${m.state}] ${m.title} (${m.user}) ${m.source_branch}→${m.target_branch}`)
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

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  registerTools(ctx, config);
  const systemPrompt = ctx.get("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:gitlab",
    order: 202,
    text: "GitLab 工具(gitlab_project / gitlab_issues / gitlab_issue_create / gitlab_issue_comment / gitlab_mr_list / gitlab_mr_create)通过 GITLAB_TOKEN 访问 GitLab REST API。引用 issue/MR 时给出 !编号与链接。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
}

export { encodeProject };
