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
import type { TrioContext } from "../lib/types.js";

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

/** 实际可用的后端:credentials 服务(挂载时)或插件自有存储。 */
async function usableBackend(ctx: TrioContext, tokenEnv: string): Promise<"credentials" | "store"> {
  const credentials = ctx.get("credentials") as CredentialsSeam | undefined;
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

/** token 配置状态(面板展示用,永不回传值)。 */
export async function credentialStatus(
  ctx: TrioContext,
  tokenEnv: string,
  label?: string,
): Promise<Record<string, unknown>> {
  const credentials = ctx.get("credentials") as CredentialsSeam | undefined;
  const status: Record<string, unknown> = { ref: tokenEnv, configured: false, source: "", writable: true };
  if (label !== undefined) status.label = label;
  const backend = await usableBackend(ctx, tokenEnv);
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

/** 写入或清除 token(credentials 服务 → 自有存储回退)。空串 = 清除。 */
export async function writeCredential(ctx: TrioContext, tokenEnv: string, value: string): Promise<void> {
  const credentials = ctx.get("credentials") as CredentialsSeam | undefined;
  const backend = await usableBackend(ctx, tokenEnv);
  if (backend === "credentials" && credentials !== undefined) {
    if (value === "") await credentials.unset(tokenEnv);
    else await credentials.set(tokenEnv, value);
  } else {
    await writeStoredToken(tokenEnv, value);
  }
}
