// dsh-trio · 凭据设置端点(GET 状态 / POST 保存)
//
// 供 github / gitlab 模块在各自的 /settings 路由复用:把 token 写进
// DSH credentials 库($DSH_HOME/.credentials.yaml,0600)。工具侧
// resolveToken 本来就优先读 credentials 服务,面板保存后无需重启即时生效。
// 端点只返回"是否已配置 + 来源",永不回传凭据值。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import { readRawBody, sendJson, sendText } from "./http.js";

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/**
 * 校验即将写入的凭据值:必须是字符串、长度受限;空串表示"清除"。
 * 返回字符串表示合法值,返回 `{ error }` 表示拒绝。
 */
export function validateCredentialValue(value: unknown): string | { error: string } {
  if (typeof value !== "string") return { error: "value must be a string" };
  if (value.length === 0) return "";
  if (value.length > 2000) return { error: "value too long" };
  return value;
}

/**
 * 注册 `<base>/settings` 端点(GET 状态 / POST 保存或清除),返回 disposer。
 * ref 固定为模块自己的 tokenEnv,客户端不能指定任意 ref。
 */
export function registerCredentialSettings(
  ctx: TrioContext,
  base: string,
  tokenEnv: string,
  label: string,
): () => void {
  const webServer = ctx.get<{ register(route: WebRoute): () => void }>("webServer");
  if (webServer === undefined) return () => {};
  const settingsPath = `${base.replace(/\/+$/, "")}/settings`;
  const credentials = ctx.get("credentials") as CredentialsSeam | undefined;
  const dispose = webServer.register({
    kind: "exact",
    path: settingsPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? "GET";
      if (method === "GET") {
        const status: Record<string, unknown> = { ref: tokenEnv, label, configured: false, source: "", writable: false };
        if (credentials !== undefined) {
          try {
            const desc = await credentials.describe(tokenEnv);
            status.configured = desc.configured;
            status.source = desc.source ?? "";
            status.writable = desc.writable !== false;
          } catch {
            /* 服务异常时按未配置处理 */
          }
        }
        if (!status.configured && process.env[tokenEnv]) {
          status.configured = true;
          status.source = "env";
          status.writable = false;
        }
        sendJson(res, 200, status);
        return;
      }
      if (method === "POST") {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse((await readRawBody(req, 8 * 1024)) || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        const checked = validateCredentialValue(body.value);
        if (typeof checked === "object") {
          sendJson(res, 400, checked);
          return;
        }
        if (credentials === undefined) {
          sendJson(res, 501, { error: "credentials service unavailable" });
          return;
        }
        try {
          if (checked === "") await credentials.unset(tokenEnv);
          else await credentials.set(tokenEnv, checked);
          const desc = await credentials.describe(tokenEnv);
          sendJson(res, 200, { ok: true, configured: desc.configured, source: desc.source ?? "" });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      sendText(res, 405, "method not allowed");
    },
  });
  return dispose;
}
