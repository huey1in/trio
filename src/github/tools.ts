// dsh-trio · GitHub — 工具注册(13 个 github_*)
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
      name: "github_issue_create",
      description: "在仓库中创建一个 issue。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "title"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          html_url: { type: "string" },
        },
        required: ["number", "html_url"],
      },
      render: (_args, value) => `Created #${value.number}: ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/issues`, {
          method: "POST",
          body: { title: args.title, body: args.body ?? "" },
        });
        return { number: data.number, html_url: data.html_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_issue_comment",
      description: "在 issue(或 PR)上发布评论。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "integer", description: "issue 或 PR 编号。" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "issue", "body"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          html_url: { type: "string" },
        },
        required: ["id", "html_url"],
      },
      render: (_args, value) => `Commented: ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/issues/${args.issue}/comments`, {
          method: "POST",
          body: { body: args.body },
        });
        return { id: data.id ?? 0, html_url: data.html_url ?? "" };
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

  tools.register(
    definePlainTool({
      name: "github_pr_review",
      description: "提交一次 PR 评审(event: COMMENT 评论 / APPROVE 通过 / REQUEST_CHANGES 请求修改)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer" },
          body: { type: "string" },
          event: { type: "string", enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
        },
        required: ["owner", "repo", "number", "body"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          state: { type: "string" },
          html_url: { type: "string" },
        },
        required: ["id", "state", "html_url"],
      },
      render: (_args, value) => `Review ${value.state}: ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}/reviews`, {
          method: "POST",
          body: { body: args.body, event: args.event ?? "COMMENT" },
        });
        return { id: data.id ?? 0, state: data.state ?? "", html_url: data.html_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_pr_comment",
      description: "在 PR 上发布普通评论(等同 issue 评论)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "number", "body"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          html_url: { type: "string" },
        },
        required: ["id", "html_url"],
      },
      render: (_args, value) => `Commented: ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/issues/${args.number}/comments`, {
          method: "POST",
          body: { body: args.body },
        });
        return { id: data.id ?? 0, html_url: data.html_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_pr_merge",
      description: "合并一个 PR(method: merge/squash/rebase)。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer" },
          method: { type: "string", enum: ["merge", "squash", "rebase"] },
        },
        required: ["owner", "repo", "number"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          merged: { type: "boolean" },
          sha: { type: "string" },
        },
        required: ["merged", "sha"],
      },
      render: (_args, value) => (value.merged ? `Merged: ${value.sha}` : "Not merged"),
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/pulls/${args.number}/merge`, {
          method: "PUT",
          body: { merge_method: args.method ?? "squash" },
        });
        return { merged: data.merged === true, sha: data.sha ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_pr_review_comment",
      description: "在 PR 的 diff 上发一条行内评论。path 为文件路径,line 为 diff 中的行号(PR 的 diff 行号,不是文件行号);body 为评论内容。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer" },
          body: { type: "string" },
          path: { type: "string", description: "评论针对的文件路径。" },
          line: { type: "integer", description: "diff 中的行号。" },
        },
        required: ["owner", "repo", "number", "body", "path", "line"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          html_url: { type: "string" },
        },
        required: ["id", "html_url"],
      },
      render: (_args, value) => `Inline comment: ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const data = await ghFetch(
          ctx,
          config,
          `/repos/${args.owner}/${args.repo}/pulls/${args.number}/comments`,
          {
            method: "POST",
            body: { body: args.body, path: args.path, line: args.line },
          },
        );
        return { id: data.id ?? 0, html_url: data.html_url ?? "" };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_issue_update",
      description: "更新 issue/PR 的状态、标签、指派、标题或正文。只更新提供的字段。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "integer", description: "issue 或 PR 编号。" },
          state: { type: "string", enum: ["open", "closed"] },
          labels: { type: "array", items: { type: "string" } },
          assignees: { type: "array", items: { type: "string" } },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "issue"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          state: { type: "string" },
          title: { type: "string" },
          html_url: { type: "string" },
        },
        required: ["number", "state", "title", "html_url"],
      },
      render: (_args, value) => `#${value.number} [${value.state}] ${value.title} — ${value.html_url}`,
      timeoutMs: 30000,
      execute: async (args) => {
        const body: Record<string, any> = {};
        if (args.state !== undefined) body.state = args.state;
        if (args.labels !== undefined) body.labels = args.labels;
        if (args.assignees !== undefined) body.assignees = args.assignees;
        if (args.title !== undefined) body.title = args.title;
        if (args.body !== undefined) body.body = args.body;
        const data = await ghFetch(ctx, config, `/repos/${args.owner}/${args.repo}/issues/${args.issue}`, {
          method: "PATCH",
          body,
        });
        return {
          number: data.number ?? 0,
          state: data.state ?? "",
          title: data.title ?? "",
          html_url: data.html_url ?? "",
        };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_search_issues",
      description: "在仓库内搜索 issue 和 PR(支持 GitHub 搜索语法,如 'is:pr is:open bug')。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          query: { type: "string", description: "搜索词,可带 GitHub 限定符。" },
          limit: { type: "integer" },
        },
        required: ["owner", "repo", "query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: { type: "array", items: { type: "object" } },
          total: { type: "integer" },
        },
        required: ["items", "total"],
      },
      render: (_args, value) =>
        value.items
          .map((i: any) => `#${i.number} [${i.state}] ${i.title} (${i.user})`)
          .join("\n") || "(no results)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50);
        const q = `repo:${args.owner}/${args.repo} ${args.query}`;
        const data = await ghFetch(
          ctx,
          config,
          `/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`,
        );
        return {
          total: data.total_count ?? 0,
          items: (data.items ?? []).map((i: any) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            user: i.user?.login ?? "",
            html_url: i.html_url ?? "",
          })),
        };
      },
    }),
  );

  tools.register(
    definePlainTool({
      name: "github_workflow_runs",
      description: "查看仓库最近的工作流(CI)运行状态。",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runs: { type: "array", items: { type: "object" } },
        },
        required: ["runs"],
      },
      render: (_args, value) =>
        value.runs
          .map((run: any) => `#${run.id} ${run.name} [${run.status}/${run.conclusion ?? "-"}] ${run.head_branch}`)
          .join("\n") || "(no runs)",
      timeoutMs: 30000,
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
        const branch = args.branch ? `&branch=${encodeURIComponent(args.branch)}` : "";
        const data = await ghFetch(
          ctx,
          config,
          `/repos/${args.owner}/${args.repo}/actions/runs?per_page=${limit}${branch}`,
        );
        return {
          runs: (data?.workflow_runs ?? []).map((run: any) => ({
            id: run.id ?? 0,
            name: run.name ?? "",
            status: run.status ?? "",
            conclusion: run.conclusion ?? null,
            head_branch: run.head_branch ?? "",
            html_url: run.html_url ?? "",
            created_at: run.created_at ?? "",
          })),
        };
      },
    }),
  );
}

