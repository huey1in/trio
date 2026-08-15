// dsh-trio · GitHub — 工具注册(4 个只读 github_*)
//
// 瘦身说明:写操作(建 issue/PR、评论、评审、合并)交给 agent 用 bash +
// gh CLI(或 curl + GITHUB_TOKEN),插件只保留 4 个高频只读工具;
// 常驻自动化(webhook 自动评审、issue 自动修复、事件看板)在 webhook.ts /
// autofix.ts,是 bash 无法替代的部分。
import type { TrioContext } from "../lib/types.js";
import type { GithubConfig } from "./types.js";
import { definePlainTool, genericCard } from "../lib/tools.js";
import { ghFetch, projectIssue, projectPr } from "./api.js";
export function registerTools(ctx: TrioContext, config: GithubConfig) {
  const tools = ctx.get("tools");
  if (tools === undefined) return;

  tools.register(
    definePlainTool({
      name: "github_repo",
      description: "获取 GitHub 仓库的元信息(星标、fork、open issues、默认分支等)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          full_name: { type: "string" },
          description: { type: "string" },
          stars: { type: "integer" },
          forks: { type: "integer" },
          open_issues: { type: "integer" },
          default_branch: { type: "string" },
          html_url: { type: "string" },
          pushed_at: { type: "string" },
        },
        required: ["full_name", "description", "stars", "forks", "open_issues", "default_branch", "html_url", "pushed_at"],
      },
      render: (_args, value) =>
        `${value.full_name} ⭐${value.stars} 🍴${value.forks} issues:${value.open_issues} default:${value.default_branch}`,
      presentCall: (args) => genericCard("github", `${args.owner}/${args.repo}`, `${args.owner}/${args.repo}`),
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}`);
        return {
          full_name: data.full_name ?? "",
          description: data.description ?? "",
          stars: data.stargazers_count ?? 0,
          forks: data.forks_count ?? 0,
          open_issues: data.open_issues_count ?? 0,
          default_branch: data.default_branch ?? "",
          html_url: data.html_url ?? "",
          pushed_at: data.pushed_at ?? "",
        };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_issues",
      description: "列出仓库的 issue(state 默认 open)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          limit: { type: "integer" },
        },
        required: ["owner", "repo"],
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
          .map((issue: any) => `#${issue.number} [${issue.state}] ${issue.title} (${issue.user})`)
          .join("\n") || "(no issues)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
        const data = await ghFetch(
          ctx,
          config,
          `/repos/${args.owner}/${args.repo}/issues?state=${args.state ?? "open"}&per_page=${limit}`,
        );
        return { issues: (data ?? []).map(projectIssue) };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_pulls",
      description: "列出仓库的 Pull Request(state 默认 open)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          limit: { type: "integer" },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pulls: { type: "array", items: { type: "object" } },
        },
        required: ["pulls"],
      },
      render: (_args, value) =>
        value.pulls
          .map((pr: any) => `#${pr.number} [${pr.state}] ${pr.title} (${pr.user}) +${pr.additions}/-${pr.deletions}`)
          .join("\n") || "(no pull requests)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
        const data = await ghFetch(
          ctx,
          config,
          `/repos/${args.owner}/${args.repo}/pulls?state=${args.state ?? "open"}&per_page=${limit}`,
        );
        return { pulls: (data ?? []).map(projectPr) };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_pr",
      description: "获取单个 PR 的详情;includeFiles=true 时附带文件变更列表(含 diff patch)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer" },
          includeFiles: { type: "boolean" },
        },
        required: ["owner", "repo", "number"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pr: { type: "object" },
        },
        required: ["pr"],
      },
      render: (args, value) =>
        `#${value.pr.number} ${value.pr.title}\n+${value.pr.additions}/-${value.pr.deletions} in ${value.pr.changed_files} files\n${args.includeFiles ? value.pr.files.map((f: any) => `${f.status} ${f.filename}`).join("\n") : ""}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const detail = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}`);
        const pr: any = projectPr(detail);
        if (args.includeFiles === true) {
          const files = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}/files?per_page=50`);
          pr.files = (files ?? []).map((file: any) => ({
            filename: file.filename,
            status: file.status ?? "",
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            patch: file.patch ?? "",
          }));
        }
        return { pr };
      },
    }),
  );
}
