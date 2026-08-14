// dsh-trio · GitHub — 类型与默认配置
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
export interface GithubEventEntry {
  ts: number;
  event: string;
  action: string;
  repo: string;
  number: number | null;
  title: string;
  handled: boolean;
  detail: string;
}

