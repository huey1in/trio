// dsh-reef · MCP Server
//
// 零依赖实现 MCP Streamable HTTP(2025-03-26)服务器,挂在 DSH 的
// ctx.webServer 路由上(默认 /reef/mcp)。把 DSH 的能力反向暴露给任何 MCP
// 客户端:Claude Desktop、Cursor、Cline、其他 agent…
//
// 暴露的工具:
//   dsh_list_sessions   列出本机 DSH 会话
//   dsh_read_session    读取某个会话的事件摘要
//   dsh_search_sessions 全文搜索会话
//   dsh_run_agent       用默认模型跑一个一次性 agent(深研/执行任务)
//
// 用法示例(客户端侧):
//   mcpServers: { "dsh": { "url": "http://127.0.0.1:3080/reef/mcp" } }

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReefContext, WebRoute } from "../lib/types.js";
import { resolveConfig, type ConfigSchema } from "../lib/config.js";
import { handlePost, handleGetWithConfig } from "./protocol.js";
import { oauthMetadata, isOAuthEnabled } from "./oauth.js";
import { urlPath, sendText, sendJson } from "../lib/http.js";
import { handleModuleSettings, sectionOverrides } from "../lib/settings.js";
import { MCP_SETTING_FIELDS } from "./settings.js";

export type { McpConfig } from "./types.js";
export { summarize, truncate, projectEvent } from "./sessions.js";
export { rpcError, rpcResult } from "./protocol.js";
export { MCP_TOOLS } from "./tools.js";

export const name = "reef-mcp";
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

const DEFAULT_CONFIG = {
  path: "/reef/mcp",
  authTokenEnv: "", // 静态 Bearer token 的环境变量名;设置后所有请求要求 Authorization: Bearer <token>
  // OAuth 2.0 client_credentials(可选,与静态 token 二选一或并存)
  oauthEnabled: false,
  oauthClientIdEnv: "MCP_CLIENT_ID",
  oauthClientSecretEnv: "MCP_CLIENT_SECRET",
  oauthTokenTtlMs: 3600000,
  oauthTokenPath: "/reef/mcp/oauth/token",
  runAgentTimeoutMs: 300000,
  runAgentMaxOutputChars: 120000,
  listSessionsLimit: 50,
};

export function apply(ctx: ReefContext, rawConfig: Record<string, any>) {
  const resolved = resolveConfig("mcp", MCP_SCHEMA, DEFAULT_CONFIG, rawConfig) as import("./types.js").McpConfig;
  if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
  const webServer = ctx.get<{ register(route: WebRoute): () => void; port?: number }>("webServer");
  if (webServer === undefined) return;
  // 面板设置覆盖:启动时合并 restart 字段(path)。
  const ov = sectionOverrides("mcp", MCP_SETTING_FIELDS);
  const config = {
    ...resolved,
    ...(typeof ov.path === "string" && ov.path ? { path: ov.path } : {}),
  };
  const base = (config.path ?? "/reef/mcp").replace(/\/+$/, "");
  const disposers: (() => void)[] = [];
  disposers.push(
    webServer.register({
      kind: "prefix",
      path: base,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const path = urlPath(req);
        const method = req.method ?? "GET";
        if (path === `${base}/settings`) {
          await handleModuleSettings(ctx, req, res, "mcp", MCP_SETTING_FIELDS);
          return;
        }
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
    ctx.logger?.info?.(`dsh-reef/mcp: MCP server at http://127.0.0.1:${port}${base}`);
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
      `dsh-reef/mcp: OAuth client_credentials enabled — token endpoint ${base}/oauth/token`,
    );
  }
}
