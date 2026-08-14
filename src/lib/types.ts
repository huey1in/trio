// dsh-trio 共享类型定义(运行时零依赖;仅编译期使用)。

/** 最小 Cordis 上下文(我们只消费这几个成员)。 */
export interface TrioContext {
  get<T = any>(name: string): T | undefined;
  effect(fn: () => (() => void) | void, label?: string): void;
  on?(event: string, listener: (...args: unknown[]) => unknown): (() => void) | void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  tools?: {
    register(definition: PlainToolDefinition): unknown;
  };
  systemPrompt?: {
    section(section: { name: string; order?: number; text: string }): () => void;
  };
}

/** 工具执行上下文(ToolRunContext 的我们用到的最小面)。 */
export interface ToolRunContext {
  signal: AbortSignal;
  agent?: {
    session?: {
      meta?: { cwd?: string };
    };
  };
  callId?: string;
}

/** 规范化工具输出契约。 */
export interface PlainToolOutput {
  schema: Record<string, unknown>;
  render: (args: unknown, value: unknown) => { type: "text"; text: string }[];
}

/** 注册到 ctx.tools 的规范化工具定义。 */
export interface PlainToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: PlainToolOutput;
  execute: (args: any, exec: ToolRunContext) => Promise<unknown> | unknown;
  presentCall?: (args: any) => unknown;
  isConcurrencySafe?: () => boolean;
  timeoutMs?: number;
}

/** webServer 路由契约。 */
export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>;
}

/** 模型选择(默认模型或显式覆盖)。 */
export interface ModelSelection {
  provider: string;
  model: string;
}

/** 会话事件的最小投影(来自持久化日志)。 */
export interface SessionEventLite {
  seq: number;
  type: string;
  [key: string]: unknown;
}
