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

import { randomUUID } from "node:crypto";
import { readJsonBody, sendJson, sendText, openSse, urlPath } from "./lib/http.js";

export const name = "trio-mcp";
export const inject = ["webServer"];

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "dsh-trio-mcp";
const SERVER_VERSION = "0.1.0";

const DEFAULT_CONFIG = {
  path: "/trio/mcp",
  authTokenEnv: "", // 设置后要求 Authorization: Bearer <token>
  runAgentTimeoutMs: 300000,
  runAgentMaxOutputChars: 120000,
  listSessionsLimit: 50,
};

/** 活跃的 GET SSE 客户端(用于推送 notifications/progress 等服务器通知)。 */
const sseWriters = new Set();

/** 向所有已连接 SSE 客户端推送一条 JSON-RPC 通知。 */
function pushNotification(method, params) {
  for (const writer of sseWriters) {
    try {
      writer.send("message", { jsonrpc: "2.0", method, params });
    } catch {
      sseWriters.delete(writer);
    }
  }
}

/** 在 tools/call 执行期间报告进度(仅当客户端带 progressToken)。 */
function makeProgressReporter(params) {
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

// ---------------------------------------------------------------------------
// JSON-RPC 工具
// ---------------------------------------------------------------------------

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function methodNotFound(id) {
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
function summarize(events, firstSeq) {
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
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data?.reason ?? null;
  }
  return { text, reason };
}

function truncate(text, maxChars) {
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断)` : text;
}

/** 事件 → 一行摘要(防御性投影,任何字段缺失都不抛错)。 */
function projectEvent(event, maxChars = 400) {
  const { seq, type, data } = event;
  const base = { seq, type };
  try {
    if (type === "assistant/message" || type === "user/message") {
      const content = data?.message?.content ?? [];
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
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

async function listSessions(ctx, args) {
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

async function readSession(ctx, args) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const sessionId = String(args?.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");
  const maxEvents = Math.min(Math.max(Number(args?.maxEvents ?? 200) || 200, 1), 2000);
  const snapshot = await query.readSession(sessionId);
  const events = (snapshot.events ?? []).slice(-maxEvents).map((event) => projectEvent(event));
  return {
    sessionId,
    cwd: snapshot.session?.cwd ?? "",
    createdAt: snapshot.session?.createdAt ?? 0,
    events,
  };
}

async function searchSessions(ctx, args) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const q = String(args?.query ?? "");
  if (!q) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 100);
  const page = await query.searchSessions({ query: q, limit });
  const hits = (page.hits ?? []).map((hit) => {
    const out = {};
    for (const key of ["sessionId", "title", "snippet", "score"]) {
      if (hit[key] !== undefined) out[key] = hit[key];
    }
    return out;
  });
  return { query: q, hits };
}

async function runAgent(ctx, args, onProgress) {
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
  const cwd = String(args?.cwd ?? "") || process.cwd();
  const sessionId = `session-${randomUUID()}`;
  onProgress?.(1, 4, "creating agent");
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions: { provider: selection.provider, model: selection.model },
  });
  try {
    await handle.agent.whenIdle();
    const firstSeq = handle.agent.session.seq;
    onProgress?.(2, 4, "agent running");
    handle.agent.followup({
      content: [{ type: "text", text: prompt }],
      source: { kind: "user" },
    });
    await handle.agent.whenIdle();
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

async function agentsStatus(ctx) {
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

async function callMcpTool(ctx, name, args, onProgress) {
  switch (name) {
    case "dsh_list_sessions":
      return listSessions(ctx, args);
    case "dsh_read_session":
      return readSession(ctx, args);
    case "dsh_search_sessions":
      return searchSessions(ctx, args);
    case "dsh_run_agent":
      return runAgent(ctx, args, onProgress);
    case "dsh_agents_status":
      return agentsStatus(ctx);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP 处理器
// ---------------------------------------------------------------------------

function checkAuth(req, config) {
  if (!config.authTokenEnv) return true;
  const token = process.env[config.authTokenEnv];
  if (!token) return true; // 未配置 token 时不拦截(配置了才要求)
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function handlePost(req, res, ctx, config) {
  if (!checkAuth(req, config)) {
    sendJson(res, 401, rpcError(null, -32001, "Unauthorized"));
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
  const { id, method, params } = message;
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
      response = rpcResult(id, { tools: MCP_TOOLS });
      break;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const onProgress = makeProgressReporter(params);
      try {
        const result = await callMcpTool(ctx, name, args, onProgress);
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
function handleGetWithConfig(req, res, config) {
  if (!checkAuth(req, config)) {
    sendJson(res, 401, rpcError(null, -32001, "Unauthorized"));
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

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = config.path.replace(/\/+$/, "");
  const disposers = [];
  disposers.push(
    webServer.register({
      kind: "prefix",
      path: base,
      handler: async (req, res) => {
        const path = urlPath(req);
        const method = req.method ?? "GET";
        if (path !== base && path !== `${base}/`) {
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
}
