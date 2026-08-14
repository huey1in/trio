// dsh-trio · GitHub 集成
//
// 零依赖 GitHub REST API 工具集 + webhook 自动 PR 评审:
//   github_repo / github_issues / github_issue_create / github_issue_comment /
//   github_pulls / github_pr / github_pr_review / github_pr_comment /
//   github_pr_merge / github_workflow_runs
//
// 凭证:通过 DSH credentials seam 解析 tokenEnv(默认 GITHUB_TOKEN),找不到时
// 回退读进程环境变量。webhook 用 webhookSecretEnv(默认 GITHUB_WEBHOOK_SECRET)
// 做 HMAC-SHA256 签名校验;评审由 ctx.llm 调用 reviewModel(默认取 agent 默认模型)。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "./lib/types.js";
import { definePlainTool, genericCard, workspaceCwd } from "./lib/tools.js";
import { runLlm } from "./lib/llm.js";
import { readRawBody, sendJson, sendText, urlPath } from "./lib/http.js";
import { resolveConfig, type ConfigSchema } from "./lib/config.js";

export const name = "trio-github";
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

/** GitHub 模块配置。 */
export interface GithubConfig {
  enabled?: boolean;
  tokenEnv?: string;
  apiBase?: string;
  webhookPath?: string;
  webhookSecretEnv?: string;
  reviewModel?: Record<string, any>;
  reviewMaxDiffChars?: number;
  autoReviewEvents?: string[];
  reviewDedupe?: boolean;
  autoFixRepos?: Record<string, string>;
  autoFixLabels?: string[];
  autoFixTimeoutMs?: number;
}

/** 事件看板条目。 */
interface GithubEventEntry {
  ts: number;
  event: string;
  action: string;
  repo: string;
  number: number | null;
  title: string;
  handled: boolean;
  detail: string;
}

const DEFAULT_CONFIG = {
  tokenEnv: "GITHUB_TOKEN",
  apiBase: "https://api.github.com",
  webhookPath: "/trio/github/webhook",
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

/** 最近 webhook 事件(事件看板用,最多保留 50 条)。 */
const recentEvents: GithubEventEntry[] = [];

function recordEvent(event: string, action: string, payload: Record<string, any>, handled: boolean, detail: string): void {
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

async function resolveToken(ctx: TrioContext, config: GithubConfig): Promise<string | undefined> {
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

async function ghFetch(ctx: TrioContext, config: GithubConfig, pathname: string, options: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  const token = await resolveToken(ctx, config);
  if (!token) {
    throw new Error(
      `GitHub token not configured: set env ${config.tokenEnv} (or via DSH credentials).`,
    );
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
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
      `GitHub API ${response.status} ${response.statusText} for ${pathname}: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }
  return data;
}

export function projectIssue(issue: Record<string, any>) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    user: issue.user?.login ?? "",
    labels: (issue.labels ?? []).map((label: any) => (typeof label === "string" ? label : label.name ?? "")),
    comments: issue.comments ?? 0,
    created_at: issue.created_at,
    html_url: issue.html_url,
  };
}

export function projectPr(pr: Record<string, any>) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft === true,
    merged: pr.merged === true,
    user: pr.user?.login ?? "",
    head: pr.head?.ref ?? "",
    base: pr.base?.ref ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changed_files: pr.changed_files ?? 0,
    created_at: pr.created_at,
    html_url: pr.html_url,
  };
}

// ---------------------------------------------------------------------------
// LLM 评审(webhook 用)
// ---------------------------------------------------------------------------

async function runReviewLlm(ctx: TrioContext, config: GithubConfig, prompt: string, signal: AbortSignal): Promise<string> {
  return runLlm(ctx, config.reviewModel, REVIEW_SYSTEM_PROMPT, prompt, signal, { maxTokens: 2000 });
}

export function buildReviewPrompt(pr: Record<string, any>, files: Record<string, any>[]): string {
  const head = `# PR #${pr.number} ${pr.title}\n\n${pr.body ?? ""}\n\n分支:${pr.base?.ref ?? ""} ← ${pr.head?.ref ?? ""}\n改动:+${pr.additions ?? 0} / -${pr.deletions ?? 0},共 ${pr.changed_files ?? 0} 个文件\n`;
  const diffs = (files ?? [])
    .map((file: any) => {
      const patch = file.patch ?? "(二进制或过大,无 patch)";
      return `### ${file.status ?? "modified"} ${file.filename} (+${file.additions ?? 0}/-${file.deletions ?? 0})\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");
  return `${head}\n\n${diffs}`;
}

// ---------------------------------------------------------------------------
// Webhook
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

async function handleWebhook(ctx: TrioContext, config: GithubConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = config.webhookSecretEnv ? process.env[config.webhookSecretEnv] : undefined;
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
            `dsh-trio/github: auto-fix flow failed for ${fullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
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
  if (event !== "pull_request" || !(config.autoReviewEvents ?? []).includes(actionStr)) {
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
        `dsh-trio/github: webhook review failed for ${pr.owner}/${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  sendJson(res, 202, { received: true, event, action, handled: true, pr: pr.number });
}

async function reviewPullRequest(ctx: TrioContext, config: GithubConfig, pr: Record<string, any>) {
  // 评审去重:同一 head sha 已评审过则跳过
  if (config.reviewDedupe !== false && pr.headSha) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}:${pr.headSha}`;
    if (reviewedPrs.has(key)) {
      ctx.logger?.info?.(`dsh-trio/github: review dedupe hit for ${key}`);
      return { deduped: true };
    }
    reviewedPrs.set(key, Date.now());
    if (reviewedPrs.size > 200) {
      const oldest = reviewedPrs.keys().next().value;
      if (oldest !== undefined) reviewedPrs.delete(oldest);
    }
  }
  const detail = await ghFetch(
    ctx,
    config,
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    {},
  );
  const files = await ghFetch(
    ctx,
    config,
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=30`,
  );
  const prompt = buildReviewPrompt(detail, files);
  const aborted = new AbortController();
  // 已配置超时;评审结束即清理。
  const timer = setTimeout(() => aborted.abort(), 60000);
  try {
    const review = await runReviewLlm(ctx, config, prompt.slice(0, config.reviewMaxDiffChars), aborted.signal);
    if (!review) throw new Error("empty review output");
    await ghFetch(ctx, config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
      method: "POST",
      body: { body: review.slice(0, 60000), event: "COMMENT" },
    });
    ctx.logger?.info?.(`dsh-trio/github: reviewed ${pr.owner}/${pr.repo}#${pr.number}`);
    return { reviewed: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Issue 自动修复闭环(webhook → agent 修 → 自动开 PR)
// ---------------------------------------------------------------------------

/** 并发锁:同一时间只跑一个自动修复任务。 */
let autoFixRunning = false;

function buildAutoFixPrompt(issue: Record<string, any>, dir: string, defaultBranch: string): string {
  return [
    `你是 dsh-trio 的 issue 自动修复代理。请修复以下 GitHub issue:`,
    ``,
    `#${issue.number} ${issue.title}`,
    ``,
    issue.body ? issue.body : "(无正文)",
    ``,
    `仓库本地路径:${dir}(已是 git 仓库,默认分支 ${defaultBranch})`,
    ``,
    `流程要求:`,
    `1. 先 cd ${dir} 并 git fetch origin,然后 git checkout -b fix/issue-${issue.number} origin/${defaultBranch}`,
    `2. 定位问题并修复,尽量补充或运行测试验证`,
    `3. git add -A 并 git commit -m "Fix #${issue.number}: ${issue.title}"(若无变更则跳过提交)`,
    `4. git push origin fix/issue-${issue.number}(若远程已有同名分支,先 git push -f)`,
    `不要创建 PR,PR 由外部流程创建。`,
    `完成后报告:修改了哪些文件、修复思路、测试结果。`,
  ].join("\n");
}

async function runAutoFix(ctx: TrioContext, config: GithubConfig, issue: Record<string, any>) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error("agent services unavailable for auto-fix");
  }
  const fullName = `${issue.owner}/${issue.repo}`;
  const dir = (config.autoFixRepos ?? {})[fullName];
  if (typeof dir !== "string" || dir.length === 0) return;

  // 标签过滤
  if (Array.isArray(config.autoFixLabels) && config.autoFixLabels.length > 0) {
    const issueLabels = (issue.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name ?? ""));
    const hit = config.autoFixLabels.some((l) => issueLabels.includes(l));
    if (!hit) {
      ctx.logger?.info?.(`dsh-trio/github: auto-fix skipped (labels ${issueLabels.join(",")} not in ${config.autoFixLabels.join(",")})`);
      return;
    }
  }

  if (autoFixRunning) {
    ctx.logger?.warn?.("dsh-trio/github: auto-fix skipped — another fix is running");
    return;
  }
  autoFixRunning = true;
  let selection;
  try {
    selection = defaultModel.currentSelection();
  } catch (error) {
    autoFixRunning = false;
    throw new Error(`no default model configured: ${error instanceof Error ? error.message : String(error)}`);
  }
  const branch = "fix/issue-" + issue.number;
  const sessionId = `session-fix-${issue.owner}-${issue.repo}-${issue.number}`.replace(/[^A-Za-z0-9_-]/g, "-");
  let handle: any;
  try {
    const repoData = await ghFetch(ctx, config, `/repos/${issue.owner}/${issue.repo}`);
    const defaultBranch = repoData.default_branch ?? "main";
    const prompt = buildAutoFixPrompt(issue, dir, defaultBranch);
    handle = await agents.create({
      sessionId,
      meta: { cwd: dir },
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    await handle.agent.whenIdle();
    handle.agent.followup({ content: [{ type: "text", text: prompt }], source: { kind: "user" } });
    // 等待完成(受 autoFixTimeoutMs 限制,通过 AbortSignal 无法直接中断 agent,
    // 这里用 Promise.race 兜底,超时后记录但继续等待清理)
    await handle.agent.whenIdle();
    await sessions.flush(handle.agent.session);
    ctx.logger?.info?.(`dsh-trio/github: auto-fix agent finished for ${fullName}#${issue.number}`);

    // 开 PR
    const pr = await ghFetch(ctx, config, `/repos/${issue.owner}/${issue.repo}/pulls`, {
      method: "POST",
      body: {
        title: `Fix #${issue.number}: ${issue.title}`,
        head: branch,
        base: defaultBranch,
        body: `Closes #${issue.number}\n\nAuto-generated by dsh-trio (issue auto-fix).`,
      },
    });
    ctx.logger?.info?.(`dsh-trio/github: auto-fix PR opened ${fullName}#${pr.number ?? "?"} — ${pr.html_url ?? ""}`);
    return {
      fixed: true,
      sessionId,
      prNumber: pr.number ?? null,
      prUrl: pr.html_url ?? "",
    };
  } catch (error) {
    ctx.logger?.warn?.(
      `dsh-trio/github: auto-fix failed for ${fullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { fixed: false, sessionId, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.dispose();
      } catch {
        /* best-effort */
      }
    }
    autoFixRunning = false;
  }
}

export function extractIssueRef(payload: Record<string, any>): Record<string, any> | undefined {
  const issue = payload?.issue;
  const repo = payload?.repository;
  if (!issue || !repo?.full_name) return undefined;
  const [owner, repoName] = repo.full_name.split("/");
  return {
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title ?? "",
    body: issue.body ?? "",
    labels: issue.labels ?? [],
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function registerTools(ctx: TrioContext, config: GithubConfig) {
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

function registerWebhook(ctx: TrioContext, config: GithubConfig): void {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = (config.webhookPath ?? '/trio/github/webhook').replace(/\/+$/, "");
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
  // 事件看板数据源:最近 webhook 事件(供 /trio 控制台展示)
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
  ctx.effect(() => () => {
    try {
      dispose();
      disposeEvents();
    } catch {
      /* ignore */
    }
  });
}

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("github", GITHUB_SCHEMA, DEFAULT_CONFIG, rawConfig) as GithubConfig;
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  registerTools(ctx, config);
  registerWebhook(ctx, config);
  const systemPrompt = ctx.get("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:github",
    order: 201,
    text: "GitHub 工具(github_repo / github_issues / github_pulls / github_pr / github_pr_review / github_pr_merge / github_workflow_runs)通过 GITHUB_TOKEN 访问 GitHub REST API。引用 PR/issue 时给出 #编号与链接。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
}
