// dsh-trio · MCP — 类型
/** MCP 模块配置。 */
export interface McpConfig {
  enabled?: boolean;
  path?: string;
  authTokenEnv?: string;
  oauthEnabled?: boolean;
  oauthClientIdEnv?: string;
  oauthClientSecretEnv?: string;
  oauthTokenTtlMs?: number;
  oauthTokenPath?: string;
  runAgentTimeoutMs?: number;
  runAgentMaxOutputChars?: number;
  listSessionsLimit?: number;
}

/** 进度回调(progressToken 上报)。 */
export type ProgressFn = (progress: number, total: number, message?: string) => void;
/** 流式输出回调(assistant 文本增量)。 */
export type DeltaFn = (delta: string) => void;

