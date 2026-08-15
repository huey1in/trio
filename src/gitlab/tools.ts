// dsh-reef · GitLab — 工具注册(3 个只读 gitlab_*)
//
// 瘦身说明:写操作(建 issue/MR、评论)交给 agent 用 bash + glab CLI
// (或 curl + GITLAB_TOKEN),插件只保留 3 个高频只读工具;
// 常驻自动化(webhook MR 评审)在 webhook.ts,是 bash 无法替代的部分。
import type { ReefContext } from "../lib/types.js";
import type { GitlabConfig } from "./types.js";
import { definePlainTool, genericCard } from "../lib/tools.js";
import { glFetch, encodeProject, projectIssue, projectMr } from "./api.js";
export function registerTools(ctx: ReefContext, config: GitlabConfig) {
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
}
