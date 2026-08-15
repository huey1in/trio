// dsh-reef · GitHub — REST API 层(token 解析、请求与重试、字段投影)
import type { ReefContext } from "../lib/types.js";
import type { GithubConfig } from "./types.js";
import { readStoredToken } from "../lib/credentials.js";

/** "owner/repo" → URL 编码的 project id(owner%2Frepo)。 */
export function encodeProject(project: string): string {
  return encodeURIComponent(String(project));
}
export async function resolveToken(ctx: ReefContext, config: GithubConfig): Promise<string | undefined> {
  try {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(config.tokenEnv);
      if (resolved?.value) return resolved.value;
    }
  } catch {
    /* fall through to env */
  }
  const envValue = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
  if (envValue) return envValue;
  // 面板设置写入的插件自有存储(credentials 服务缺失时的回退)
  return await readStoredToken(config.tokenEnv ?? "GITHUB_TOKEN");
}

export async function ghFetch(ctx: ReefContext, config: GithubConfig, pathname: string, options: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  const token = await resolveToken(ctx, config);
  const method = options.method ?? "GET";
  // 只读请求允许匿名(公共仓库 60 次/小时);写操作必须带 token。
  if (!token && method !== "GET") {
    throw new Error(
      `GitHub token not configured: set env ${config.tokenEnv} (or via DSH credentials).`,
    );
  }
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "dsh-reef",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  const retries = method === "GET" ? 2 : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`${config.apiBase}${pathname}`, {
        method,
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
    const hint = !token && response.status === 403
      ? " (anonymous access is rate-limited to 60 req/h per IP; set GITHUB_TOKEN to lift)"
      : "";
    throw new Error(
      `GitHub API ${response.status} ${response.statusText} for ${pathname}: ${JSON.stringify(data).slice(0, 500)}${hint}`,
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

