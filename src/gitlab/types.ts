// dsh-reef · GitLab — 类型
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

