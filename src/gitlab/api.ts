// dsh-reef · GitLab — REST API 层
import type { ReefContext } from "../lib/types.js";
import type { GitlabConfig } from "./types.js";
import { readStoredToken } from "../lib/credentials.js";

export function encodeProject(project: string): string {
  return encodeURIComponent(String(project));
}
export async function resolveToken(ctx: ReefContext, config: GitlabConfig): Promise<string | undefined> {
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
  return await readStoredToken(config.tokenEnv ?? "GITLAB_TOKEN");
}

export async function glFetch(ctx: ReefContext, config: GitlabConfig, pathname: string, options: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  const token = await resolveToken(ctx, config);
  if (!token) {
    throw new Error(
      `GitLab token not configured: set env ${config.tokenEnv} (or via DSH credentials).`,
    );
  }
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": token,
    "user-agent": "dsh-reef",
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

