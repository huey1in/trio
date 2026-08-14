// dsh-trio · MCP — Streamable HTTP 协议层(JSON-RPC 分发、鉴权、SSE)
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import type { McpConfig, ProgressFn, DeltaFn } from "./types.js";
import { readJsonBody, sendJson, sendText, openSse, urlPath, type SseWriter } from "../lib/http.js";
import { MCP_TOOLS } from "./tools.js";
import { resourcesList, resourcesRead } from "./sessions.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "dsh-trio-mcp";
const SERVER_VERSION = "0.3.0";
import { callMcpTool } from "./dispatch.js";
import { handleOAuthToken, oauthMetadata, isOAuthEnabled, checkOAuthToken, oauthClientCredentials } from "./oauth.js";
const sseWriters = new Set<SseWriter>();
/** OAuth client_credentials 签发的 token → 过期时间戳(ms)。 */
const oauthTokens = new Map();

/** 向所有已连接 SSE 客户端推送一条 JSON-RPC 通知。 */
export function pushNotification(method: string, params: Record<string, unknown>) {
  for (const writer of sseWriters) {
    try {
      writer.send("message", { jsonrpc: "2.0", method, params });
    } catch {
      sseWriters.delete(writer);
    }
  }
}

/** 在 tools/call 执行期间报告进度(仅当客户端带 progressToken)。 */
export function makeProgressReporter(params: Record<string, any>): ProgressFn | undefined {
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
export function makeDeltaReporter(params: Record<string, any>): DeltaFn | undefined {
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

export function methodNotFound(id: any) {
  return rpcError(id, -32601, "Method not found");
}

// ---------------------------------------------------------------------------
// MCP 工具实现
// ---------------------------------------------------------------------------


export function checkAuth(req: IncomingMessage, config: McpConfig): boolean {
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

export function sendUnauthorized(res: ServerResponse, config: McpConfig, req: IncomingMessage): void {
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

export async function handlePost(req: IncomingMessage, res: ServerResponse, ctx: TrioContext, config: McpConfig): Promise<void> {
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
export function handleGetWithConfig(req: IncomingMessage, res: ServerResponse, config: McpConfig): void {
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

