// dsh-trio · MCP Server
//
// 零依赖实现 MCP Streamable HTTP(2025-03-26)服务器,挂在 DSH 的
// ctx.webServer 路由上(默认 /trio/mcp)。把 DSH 的能力反向暴露给任何 MCP
// 客户端:Claude Desktop、Cursor、Cline、其他 agent…
//
// 暴露的工具:
//   dsh_list_sessions   列出本机 DSH 会话
//   dsh_read_session    读取某个会话的事件摘要
//   dsh_search_sessions 全文搜索会话
//   dsh_run_agent       用默认模型跑一个一次性 agent(深研/执行任务)
//
// 用法示例(客户端侧):
//   mcpServers: { "dsh": { "url": "http://127.0.0.1:3080/trio/mcp" } }

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "./lib/types.js";
import { readJsonBody, sendJson, sendText, openSse, urlPath, readRawBody, type SseWriter } from "./lib/http.js";
import { resolveConfig, type ConfigSchema } from "./lib/config.js";

export const name = "trio-mcp";
export const inject = ["webServer"];

const MCP_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  path: { type: "string" },
  authTokenEnv: { type: "string" },
  oauthEnabled: { type: "boolean" },
  oauthClientIdEnv: { type: "string" },
  oauthClientSecretEnv: { type: "string" },
  oauthTokenTtlMs: { type: "number", min: 1000 },
  oauthTokenPath: { type: "string" },
  runAgentTimeoutMs: { type: "number", min: 1000 },
  runAgentMaxOutputChars: { type: "number", min: 100 },
  listSessionsLimit: { type: "number", min: 1, max: 500 },
};

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
type ProgressFn = (progress: number, total: number, message?: string) => void;
/** 流式输出回调(assistant 文本增量)。 */
type DeltaFn = (delta: string) => void;

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "dsh-trio-mcp";
const SERVER_VERSION = "0.3.0";

const DEFAULT_CONFIG = {
  path: "/trio/mcp",
  authTokenEnv: "", // 静态 Bearer token 的环境变量名;设置后所有请求要求 Authorization: Bearer <token>
  // OAuth 2.0 client_credentials(可选,与静态 token 二选一或并存)
  oauthEnabled: false,
  oauthClientIdEnv: "MCP_CLIENT_ID",
  oauthClientSecretEnv: "MCP_CLIENT_SECRET",
  oauthTokenTtlMs: 3600000,
  oauthTokenPath: "/trio/mcp/oauth/token",
  runAgentTimeoutMs: 300000,
  runAgentMaxOutputChars: 120000,
  listSessionsLimit: 50,
};

/** 活跃的 GET SSE 客户端(用于推送 notifications/progress 等服务器通知)。 */
const sseWriters = new Set<SseWriter>();
/** OAuth client_credentials 签发的 token → 过期时间戳(ms)。 */
const oauthTokens = new Map();

/** 向所有已连接 SSE 客户端推送一条 JSON-RPC 通知。 */
function pushNotification(method: string, params: Record<string, unknown>) {
  for (const writer of sseWriters) {
    try {
      writer.send("message", { jsonrpc: "2.0", method, params });
    } catch {
      sseWriters.delete(writer);
    }
  }
}

/** 在 tools/call 执行期间报告进度(仅当客户端带 progressToken)。 */
function makeProgressReporter(params: Record<string, any>): ProgressFn | undefined {
  const token = params?._meta?.progressToken;
  if (token === undefined || token === null) return undefined;
  let last = -1;
  return (progress, total, message) => {
    const rounded = Math.round(progress);
    if (rounded === last) return;
    last = rounded;
    pushNotification("notifications/progress", { progressToken: token, progress: rounded, total, message });
  };
}

/** run_agent 流式输出:轮询 agent 会话,把 assistant 文本增量推给客户端。 */
function makeDeltaReporter(params: Record<string, any>): DeltaFn | undefined {
  if (params?._meta?.streamOutput !== true && params?.stream !== true) return undefined;
  return (delta) => {
    pushNotification("notifications/message", {
      level: "info",
      logger: "dsh-trio.run-agent",
      data: { kind: "agent-delta", text: delta },
    });
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// JSON-RPC 工具
// ---------------------------------------------------------------------------

export function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function rpcResult(id: any, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function methodNotFound(id: any) {
  return rpcError(id, -32601, "Method not found");
}

// ---------------------------------------------------------------------------
// MCP 工具实现
// ---------------------------------------------------------------------------

export const MCP_TOOLS = [
  {
    name: "dsh_list_sessions",
    description: "列出这台机器上 DeepSeek Harness 的会话(含标题、工作目录、创建时间)。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回多少条,默认 50。" },
      },
    },
  },
  {
    name: "dsh_read_session",
    description: "读取一个 DSH 会话的事件摘要(消息、工具调用、完成原因)。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 id(形如 session-xxx)。" },
        maxEvents: { type: "integer", description: "最多返回多少条事件,默认 200,取最新。" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "dsh_search_sessions",
    description: "全文搜索 DSH 会话(标题/内容)。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "dsh_run_agent",
    description:
      "用 DSH 的默认模型启动一个一次性 agent 执行任务(prompt),等待其完成并返回最终文本。适合深度研究、代码审查、多步骤任务。耗时可能较长;若请求带 _meta.progressToken,会通过 notifications/progress 推送进度。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "交给 agent 的任务描述。" },
        cwd: { type: "string", description: "工作目录(默认 DSH 进程目录)。" },
        provider: { type: "string", description: "覆盖默认模型的 provider(可选)。" },
        model: { type: "string", description: "覆盖默认模型的 model id(可选,与 provider 一起传)。" },
        timeoutMs: { type: "integer", description: "超时毫秒,默认 300000。" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "dsh_agents_status",
    description: "列出当前运行中的 DSH agent(会话 id 与状态)。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** 汇总一次 agent 运行:提取最新 assistant 文本与结束原因(参照官方 headless 驱动)。 */
export function summarize(events: any[], firstSeq: number) {
  let started = false;
  let text = "";
  let reason = null;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content ?? [])
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text ?? "")
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data?.reason ?? null;
  }
  return { text, reason };
}

export function truncate(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断)` : text;
}

/** 事件 → 一行摘要(防御性投影,任何字段缺失都不抛错)。 */
export function projectEvent(event: Record<string, any>, maxChars = 400) {
  const { seq, type, data } = event;
  const base = { seq, type };
  try {
    if (type === "assistant/message" || type === "user/message") {
      const content = data?.message?.content ?? [];
      const text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text ?? "")
        .join("");
      return { ...base, text: truncate(text, maxChars) };
    }
    if (type === "tool/call") {
      return { ...base, name: data?.name ?? "", args: truncate(JSON.stringify(data?.arguments ?? {}), maxChars) };
    }
    if (type === "tool/result") {
      return { ...base, error: data?.isError === true };
    }
    if (type === "turn/end") {
      return { ...base, reason: data?.reason?.kind ?? null };
    }
    return base;
  } catch {
    return base;
  }
}

async function listSessions(ctx: TrioContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const limit = Math.min(Math.max(Number(args?.limit ?? 50) || 50, 1), 200);
  const records = await query.listSessions();
  const rows = [];
  for (const record of records.slice(-limit).reverse()) {
    let title;
    try {
      const t = await query.readTitle(record.header.id);
      title = t?.title ?? "";
    } catch {
      title = "";
    }
    rows.push({
      sessionId: record.header.id,
      title,
      cwd: record.header.cwd ?? "",
      createdAt: record.header.createdAt ?? 0,
      live: record.live === true,
      persisted: record.persisted === true,
    });
  }
  return { sessions: rows };
}

async function readSession(ctx: TrioContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const sessionId = String(args?.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");
  const maxEvents = Math.min(Math.max(Number(args?.maxEvents ?? 200) || 200, 1), 2000);
  const snapshot = await query.readSession(sessionId);
  const events = (snapshot.events ?? []).slice(-maxEvents).map((event: any) => projectEvent(event));
  return {
    sessionId,
    cwd: snapshot.session?.cwd ?? "",
    createdAt: snapshot.session?.createdAt ?? 0,
    events,
  };
}

async function searchSessions(ctx: TrioContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const q = String(args?.query ?? "");
  if (!q) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 100);
  const page = await query.searchSessions({ query: q, limit });
  const hits = (page.hits ?? []).map((hit: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const key of ["sessionId", "title", "snippet", "score"]) {
      if (hit[key] !== undefined) out[key] = hit[key];
    }
    return out;
  });
  return { query: q, hits };
}

async function runAgent(ctx: TrioContext, args: Record<string, any>, onProgress: ProgressFn | undefined, onDelta: DeltaFn | undefined) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error("agent services unavailable (need agents/sessions/agentDefaultModel)");
  }
  const prompt = String(args?.prompt ?? "");
  if (!prompt.trim()) throw new Error("prompt is required");
  let selection;
  try {
    selection = defaultModel.currentSelection();
  } catch (error) {
    throw new Error(`no default model configured: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 模型覆盖:provider/model 任一传入即覆盖默认选择
  const agentOptions = {
    provider: String(args?.provider ?? "") || selection.provider,
    model: String(args?.model ?? "") || selection.model,
  };
  const cwd = String(args?.cwd ?? "") || process.cwd();
  const sessionId = `session-${randomUUID()}`;
  onProgress?.(1, 4, "creating agent");
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
  });
  try {
    await handle.agent.whenIdle();
    const firstSeq = handle.agent.session.seq;
    onProgress?.(2, 4, "agent running");
    handle.agent.followup({
      content: [{ type: "text", text: prompt }],
      source: { kind: "user" },
    });
    // 等待完成,同时轮询输出增量推送流式文本
    const donePromise = handle.agent.whenIdle();
    let seenSeq = firstSeq;
    let pushedText = "";
    while (true) {
      const events = handle.agent.session.events;
      for (const event of events) {
        if (event.seq <= seenSeq) continue;
        seenSeq = event.seq;
        if (event.type !== "assistant/message") continue;
        const text = (event.data?.message?.content ?? [])
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text ?? "")
          .join("");
        if (text.length > pushedText.length) {
          const delta = text.slice(pushedText.length);
          pushedText = text;
          onDelta?.(delta);
        }
      }
      const raced = await Promise.race([donePromise.then(() => "done"), sleep(500).then(() => "tick")]);
      if (raced === "done") break;
    }
    onProgress?.(3, 4, "collecting result");
    await sessions.flush(handle.agent.session);
    const outcome = summarize(handle.agent.session.events, firstSeq);
    onProgress?.(4, 4, "done");
    return {
      sessionId,
      text: truncate(outcome.text, 120000),
      reasonKind: outcome.reason?.kind ?? null,
      reasonCode: outcome.reason?.error?.code ?? null,
    };
  } finally {
    try {
      await handle.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function agentsStatus(ctx: TrioContext) {
  const agents = ctx.get("agents");
  if (agents === undefined) throw new Error("agents service unavailable");
  const list = agents.list();
  const agentsOut = [];
  for (const agent of list) {
    let status = "unknown";
    try {
      status = agent.status ?? "unknown";
    } catch {
      /* defensive */
    }
    agentsOut.push({ sessionId: agent.id, status });
  }
  return { agents: agentsOut, count: agentsOut.length };
}

async function resourcesList(ctx: TrioContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return { resources: [] };
  const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 50);
  const records = await query.listSessions();
  const resources = [];
  for (const record of records.slice(-limit).reverse()) {
    let title = "";
    try {
      const t = await query.readTitle(record.header.id);
      title = t?.title ?? "";
    } catch {
      /* defensive */
    }
    resources.push({
      uri: `dsh://sessions/${record.header.id}`,
      name: `${record.header.id}${title ? ` — ${title}` : ""}`,
      description: `DSH 会话${record.header.cwd ? ` (cwd: ${record.header.cwd})` : ""}`,
      mimeType: "application/json",
    });
  }
  return { resources };
}

async function resourcesRead(ctx: TrioContext, args: Record<string, any>) {
  const uri = String(args?.uri ?? "");
  const match = uri.match(/^dsh:\/\/sessions\/(.+)$/);
  if (!match) throw new Error(`unsupported resource uri: ${uri}`);
  const sessionId = match[1];
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const snapshot = await query.readSession(sessionId);
  const events = (snapshot.events ?? []).slice(-500).map((event: any) => projectEvent(event, 2000));
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            sessionId,
            cwd: snapshot.session?.cwd ?? "",
            createdAt: snapshot.session?.createdAt ?? 0,
            events,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function callMcpTool(ctx: TrioContext, name: string, args: Record<string, any>, onProgress: ProgressFn | undefined, onDelta: DeltaFn | undefined) {
  switch (name) {
    case "dsh_list_sessions":
      return listSessions(ctx, args);
    case "dsh_read_session":
      return readSession(ctx, args);
    case "dsh_search_sessions":
      return searchSessions(ctx, args);
    case "dsh_run_agent":
      return runAgent(ctx, args, onProgress, onDelta);
    case "dsh_agents_status":
      return agentsStatus(ctx);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 client_credentials(轻量实现)
// ---------------------------------------------------------------------------

function isOAuthEnabled(config: McpConfig): boolean {
  return config.oauthEnabled === true;
}

function oauthClientCredentials(config: McpConfig) {
  if (!isOAuthEnabled(config)) return undefined;
  const id = config.oauthClientIdEnv ? process.env[config.oauthClientIdEnv] : undefined;
  const secret = config.oauthClientSecretEnv ? process.env[config.oauthClientSecretEnv] : undefined;
  if (!id || !secret) return undefined;
  return { id, secret };
}

function checkOAuthToken(token: string): boolean {
  if (!token) return false;
  const expiry = oauthTokens.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    oauthTokens.delete(token);
    return false;
  }
  return true;
}

/** 处理 POST token 端点(grant_type=client_credentials)。 */
async function handleOAuthToken(req: IncomingMessage, res: ServerResponse, config: McpConfig): Promise<void> {
  const raw = await readRawBody(req, 16384);
  let params;
  try {
    params = new URLSearchParams(raw ?? "");
  } catch {
    sendJson(res, 400, { error: "invalid_request", error_description: "malformed form body" });
    return;
  }
  const grant = params.get("grant_type");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  const expected = oauthClientCredentials(config);
  if (grant !== "client_credentials") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }
  if (expected === undefined || clientId !== expected.id || clientSecret !== expected.secret) {
    sendJson(res, 401, { error: "invalid_client" });
    return;
  }
  const token = randomBytes(24).toString("hex");
  oauthTokens.set(token, Date.now() + (config.oauthTokenTtlMs ?? 3600000));
  if (oauthTokens.size > 200) {
    const now = Date.now();
    for (const [k, v] of oauthTokens) {
      if (v < now) oauthTokens.delete(k);
    }
  }
  sendJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.floor((config.oauthTokenTtlMs ?? 3600000) / 1000),
    scope: "dsh",
  });
}

/** OAuth 授权服务器元数据(RFC 8414)。 */
function oauthMetadata(config: McpConfig, host: string) {
  const base = `http://${host}${(config.path ?? "/trio/mcp").replace(/\/+$/, "")}`;
  return {
    issuer: base,
    token_endpoint: `${base}/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    response_types_supported: [],
    grant_types_supported: ["client_credentials"],
    scopes_supported: ["dsh"],
    code_challenge_methods_supported: [],
  };
}

// ---------------------------------------------------------------------------
// HTTP 处理器
// ---------------------------------------------------------------------------

function checkAuth(req: IncomingMessage, config: McpConfig): boolean {
  const header = req.headers.authorization ?? "";
  // 静态 token(如果配置了)
  if (config.authTokenEnv) {
    const token = process.env[config.authTokenEnv];
    if (token && header === `Bearer ${token}`) return true;
  }
  // OAuth client_credentials 签发的 token
  if (isOAuthEnabled(config)) {
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (checkOAuthToken(bearer)) return true;
  }
  // 未配置任何鉴权时不拦截
  const hasAuth = config.authTokenEnv || isOAuthEnabled(config);
  return !hasAuth;
}

function sendUnauthorized(res: ServerResponse, config: McpConfig, req: IncomingMessage): void {
  const host = req.headers.host ?? "127.0.0.1";
  const headers: Record<string, string> = {};
  if (isOAuthEnabled(config)) {
    const meta = oauthMetadata(config, host);
    headers["www-authenticate"] = `Bearer realm="${meta.issuer}"`;
    headers["x-oauth-server-metadata"] = `http://${host}/.well-known/oauth-authorization-server`;
  } else {
    headers["www-authenticate"] = 'Bearer realm="dsh-trio-mcp"';
  }
  sendJson(res, 401, rpcError(null, -32001, "Unauthorized"), headers);
}

async function handlePost(req: IncomingMessage, res: ServerResponse, ctx: TrioContext, config: McpConfig): Promise<void> {
  const path = urlPath(req);
  const base = (config.path ?? "/trio/mcp").replace(/\/+$/, "");
  // token 端点是发证处,必须先于鉴权处理
  if (isOAuthEnabled(config) && path === `${base}/oauth/token`) {
    await handleOAuthToken(req, res, config);
    return;
  }
  if (!checkAuth(req, config)) {
    sendUnauthorized(res, config, req);
    return;
  }
  let message;
  try {
    message = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (message === undefined) {
    sendJson(res, 400, rpcError(null, -32700, "empty body"));
    return;
  }
  const msg = message as Record<string, any>;
  const id = msg.id;
  const method = msg.method;
  const params = msg.params;
  const isNotification = id === undefined || id === null;
  let response;
  switch (method) {
    case "initialize":
      response = rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      break;
    case "notifications/initialized":
    case "notifications/cancelled":
      // 通知:无需响应
      if (isNotification) {
        res.writeHead(202, { "content-type": "application/json" });
        res.end();
        return;
      }
      response = rpcResult(id, {});
      break;
    case "ping":
      response = rpcResult(id, {});
      break;
    case "tools/list":
      response = rpcResult(id, {
        tools: MCP_TOOLS,
        resources: [
          {
            uri: "dsh://sessions",
            name: "DSH 会话列表",
            description: "列出最近的 DSH 会话资源(dsh://sessions/<id> 读取)。",
            mimeType: "application/json",
          },
        ],
      });
      break;
    case "resources/list":
      try {
        const result = await resourcesList(ctx, params);
        response = rpcResult(id, result);
      } catch (error) {
        response = rpcError(id, -32602, error instanceof Error ? error.message : String(error));
      }
      break;
    case "resources/read":
      try {
        const result = await resourcesRead(ctx, params);
        response = rpcResult(id, result);
      } catch (error) {
        response = rpcError(id, -32602, error instanceof Error ? error.message : String(error));
      }
      break;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const onProgress = makeProgressReporter(params);
      const onDelta = makeDeltaReporter(params);
      try {
        const result = await callMcpTool(ctx, name, args, onProgress, onDelta);
        response = rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        response = rpcResult(id, {
          content: [{ type: "text", text }],
          isError: true,
        });
      }
      break;
    }
    default:
      response = methodNotFound(id);
  }
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/event-stream")) {
    const writer = openSse(res);
    writer.send("message", response);
    writer.close();
  } else {
    sendJson(res, 200, response);
  }
}

// GET: 打开服务器 → 客户端 SSE 流(按协议先发 endpoint 事件;同时注册为
// 通知通道,run_agent 等长任务通过它推送 notifications/progress)。
// DELETE: 客户端会话结束,无状态实现直接 200。
function handleGetWithConfig(req: IncomingMessage, res: ServerResponse, config: McpConfig): void {
  if (!checkAuth(req, config)) {
    sendUnauthorized(res, config, req);
    return;
  }
  const writer = openSse(res);
  sseWriters.add(writer);
  const host = req.headers.host ?? "127.0.0.1";
  writer.send("endpoint", { uri: `http://${host}${config.path}` });
  const keepAlive = setInterval(() => writer.comment("keep-alive"), 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    sseWriters.delete(writer);
    writer.close();
  });
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("mcp", MCP_SCHEMA, DEFAULT_CONFIG, rawConfig) as McpConfig;
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = (config.path ?? "/trio/mcp").replace(/\/+$/, "");
  const disposers: (() => void)[] = [];
  disposers.push(
    webServer.register({
      kind: "prefix",
      path: base,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const path = urlPath(req);
        const method = req.method ?? "GET";
        const isTokenPath = isOAuthEnabled(config) && path === `${base}/oauth/token`;
        if (path !== base && path !== `${base}/` && !isTokenPath) {
          sendText(res, 404, "not found");
          return;
        }
        if (method === "POST") {
          await handlePost(req, res, ctx, config);
          return;
        }
        if (method === "GET") {
          handleGetWithConfig(req, res, config);
          return;
        }
        if (method === "DELETE") {
          // 客户端断开会话;无状态实现直接 200
          res.writeHead(200, { "content-type": "application/json" });
          res.end();
          return;
        }
        sendText(res, 405, "method not allowed");
      },
    }),
  );
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  });
  const port = webServer.port;
  if (typeof port === "number") {
    ctx.logger?.info?.(`dsh-trio/mcp: MCP server at http://127.0.0.1:${port}${base}`);
  }
  // OAuth 授权服务器元数据(RFC 8414 discovery)
  if (isOAuthEnabled(config)) {
    const discoveryDispose = webServer.register({
      kind: "exact",
      path: "/.well-known/oauth-authorization-server",
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if ((req.method ?? "GET") !== "GET") {
          sendText(res, 405, "method not allowed");
          return;
        }
        const host = req.headers.host ?? `127.0.0.1:${port}`;
        sendJson(res, 200, oauthMetadata(config, host));
      },
    });
    disposers.push(discoveryDispose);
    ctx.logger?.info?.(
      `dsh-trio/mcp: OAuth client_credentials enabled — token endpoint ${base}/oauth/token`,
    );
  }
}
