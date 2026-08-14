// dsh-trio · MCP — OAuth 2.0 client_credentials(轻量实现)
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpConfig } from "./types.js";
import { readRawBody, sendJson } from "../lib/http.js";
const oauthTokens = new Map();

/** 向所有已连接 SSE 客户端推送一条 JSON-RPC 通知。 */

export function isOAuthEnabled(config: McpConfig): boolean {
  return config.oauthEnabled === true;
}

export function oauthClientCredentials(config: McpConfig) {
  if (!isOAuthEnabled(config)) return undefined;
  const id = config.oauthClientIdEnv ? process.env[config.oauthClientIdEnv] : undefined;
  const secret = config.oauthClientSecretEnv ? process.env[config.oauthClientSecretEnv] : undefined;
  if (!id || !secret) return undefined;
  return { id, secret };
}

export function checkOAuthToken(token: string): boolean {
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
export async function handleOAuthToken(req: IncomingMessage, res: ServerResponse, config: McpConfig): Promise<void> {
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
export function oauthMetadata(config: McpConfig, host: string) {
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

