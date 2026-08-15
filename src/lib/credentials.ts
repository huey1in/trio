// dsh-trio · 凭据设置端点(GET 状态 / POST 保存)+ 插件自有 token 存储
//
// 供 github / gitlab 模块在各自的 /settings 路由复用。保存优先级:
//   1. DSH credentials 服务(若部署挂载了 provider,写入 $DSH_HOME/.credentials.yaml);
//   2. 插件自有文件存储 $DSH_HOME/.dsh-trio/tokens.json(0600)。
// 工具侧 resolveToken 按 credentials 服务 → 环境变量 → 自有存储的顺序解析,
// 面板保存后无需重启即时生效。端点只返回"是否已配置 + 来源",永不回传凭据值。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import { readRawBody, sendJson, sendText } from "./http.js";

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 插件自有 token 存储(credentials 服务缺失时的回退)
// ---------------------------------------------------------------------------

/** 自有 token 存储文件路径($DSH_HOME/.dsh-trio/tokens.json)。 */
export function tokenStorePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, ".dsh-trio", "tokens.json");
}

function readStore(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(tokenStorePath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** 读自有存储中的 token(ref 未存或为空时返回 undefined)。 */
export async function readStoredToken(ref: string): Promise<string | undefined> {
  const value = readStore()[ref];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 写自有存储;空串表示清除。 */
export async function writeStoredToken(ref: string, value: string): Promise<void> {
  const file = tokenStorePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const store = readStore();
  if (value === "") delete store[ref];
  else store[ref] = value;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** 自有存储的配置状态(与 credentials.describe 同构)。 */
export async function describeStoredToken(ref: string): Promise<{ configured: boolean; source: string; writable: boolean }> {
  const value = await readStoredToken(ref);
  return value !== undefined
    ? { configured: true, source: "store", writable: true }
    : { configured: false, source: "", writable: true };
}

// ---------------------------------------------------------------------------
// 设置端点
// ---------------------------------------------------------------------------

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

  /** 实际可用的后端:credentials 服务(挂载时)或插件自有存储。 */
  async function usableBackend(): Promise<"credentials" | "store"> {
    if (credentials !== undefined) {
      try {
        await credentials.describe(tokenEnv);
        return "credentials";
      } catch {
        /* 服务异常,回退自有存储 */
      }
    }
    return "store";
  }

  async function statusOf(): Promise<Record<string, unknown>> {
    const status: Record<string, unknown> = { ref: tokenEnv, label, configured: false, source: "", writable: true };
    const backend = await usableBackend();
    if (backend === "credentials" && credentials !== undefined) {
      const desc = await credentials.describe(tokenEnv);
      status.configured = desc.configured;
      status.source = desc.source ?? "";
      status.writable = desc.writable !== false;
    }
    if (!status.configured) {
      const envValue = process.env[tokenEnv];
      if (envValue) {
        status.configured = true;
        status.source = "env";
        status.writable = false;
      } else {
        const desc = await describeStoredToken(tokenEnv);
        status.configured = desc.configured;
        status.source = desc.source;
      }
    }
    return status;
  }

  const dispose = webServer.register({
    kind: "exact",
    path: settingsPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? "GET";
      if (method === "GET") {
        sendJson(res, 200, await statusOf());
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
        const backend = await usableBackend();
        try {
          if (backend === "credentials" && credentials !== undefined) {
            if (checked === "") await credentials.unset(tokenEnv);
            else await credentials.set(tokenEnv, checked);
          } else {
            await writeStoredToken(tokenEnv, checked);
          }
          const status = await statusOf();
          sendJson(res, 200, { ok: true, ...status });
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
