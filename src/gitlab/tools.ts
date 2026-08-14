// dsh-trio · GitLab — 工具注册(7 个 gitlab_*)
import type { TrioContext } from "../lib/types.js";
import type { GitlabConfig } from "./types.js";
import { definePlainTool, genericCard } from "../lib/tools.js";
import { glFetch, encodeProject, projectIssue, projectMr } from "./api.js";
export function registerTools(ctx: TrioContext, config: GitlabConfig) {
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

