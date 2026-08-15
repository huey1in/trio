// dsh-trio · 运行时设置存储($DSH_HOME/.dsh-trio/settings.json)+ 通用设置端点
//
// 面板 ⚙ 设置区的后端:每个模块注册自己的字段白名单(FieldSpec),POST 写入前
// 按白名单校验类型/枚举,原子写入 0600 文件。模块在使用时点读取覆盖值;
// restart 字段只在模块启动时合并(改动需重启 DSH)。
// 密钥类字段(password)永不回显,GET 只报 configured。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import { readRawBody, sendJson, sendText } from "./http.js";
import { validateCredentialValue, credentialStatus, writeCredential } from "./credentials.js";

export interface FieldSpec {
  key: string;
  label: string;
  type: "string" | "password" | "number" | "boolean" | "enum";
  options?: string[];
  /** 仅启动时生效(路径类配置)。 */
  restart?: boolean;
  defaultValue: unknown;
}

type SectionStore = Record<string, Record<string, unknown>>;

/** 设置存储文件路径($DSH_HOME/.dsh-trio/settings.json)。 */
export function settingsStorePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, ".dsh-trio", "settings.json");
}

/** 读取整个设置存储(文件缺失/损坏时返回空对象)。 */
export function readTrioSettings(): SectionStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsStorePath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as SectionStore : {};
  } catch {
    return {};
  }
}

/**
 * 校验单个字段值。返回 { ok: true, value } 或 { ok: false, error }。
 * 空字符串对所有类型都表示"清除覆盖"(password 除外由调用方决定)。
 */
export function validateFieldValue(spec: FieldSpec, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === "") return { ok: true, value: undefined }; // 清除覆盖
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: `${spec.key} must be a boolean` };
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      const num = Number(value);
      if (value !== "" && value !== null && Number.isFinite(num) && String(value).trim() !== "") return { ok: true, value: num };
      return { ok: false, error: `${spec.key} must be a finite number` };
    }
    case "enum": {
      if (typeof value !== "string" || !(spec.options ?? []).includes(value)) {
        return { ok: false, error: `${spec.key} must be one of: ${(spec.options ?? []).join(", ")}` };
      }
      return { ok: true, value };
    }
    case "string":
    case "password":
    default: {
      if (typeof value !== "string") return { ok: false, error: `${spec.key} must be a string` };
      if (value.length > 2000) return { ok: false, error: `${spec.key} too long` };
      return { ok: true, value };
    }
  }
}

/**
 * 校验并合并一个 section 的 patch 后原子写入。非法字段整批拒绝(先全部校验)。
 */
export async function writeSettingsSection(section: string, patch: Record<string, unknown>, spec: FieldSpec[]): Promise<void> {
  const allowed = new Map(spec.map((f) => [f.key, f]));
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = allowed.get(key);
    if (field === undefined) throw new Error(`unknown setting: ${section}.${key}`);
    const checked = validateFieldValue(field, value);
    if (!checked.ok) throw new Error(checked.error);
    if (checked.value === undefined) {
      cleaned[key] = ""; // 空串 = 显式清除覆盖(合并阶段删除)
      continue;
    }
    cleaned[key] = checked.value;
  }
  const file = settingsStorePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const store = readTrioSettings();
  const sectionStore: Record<string, unknown> = { ...(store[section] ?? {}) };
  for (const [key, value] of Object.entries(cleaned)) {
    if (value === "") delete sectionStore[key];
    else sectionStore[key] = value;
  }
  store[section] = sectionStore;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 读取某 section 的有效覆盖值(按 spec 校验,非法值丢弃)。
 * 不含默认值——调用方自行回退到模块默认配置。
 */
export function sectionOverrides(section: string, spec: FieldSpec[]): Record<string, unknown> {
  const stored = readTrioSettings()[section];
  if (stored === undefined) return {};
  const allowed = new Map(spec.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    const field = allowed.get(key);
    if (field === undefined) continue;
    const checked = validateFieldValue(field, value);
    if (checked.ok && checked.value !== undefined) out[key] = checked.value;
  }
  return out;
}

/** 一个字段的展示状态(含当前有效值;password 不回显)。 */
function fieldState(field: FieldSpec, overrides: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: field.key,
    label: field.label,
    type: field.type,
    restart: field.restart === true,
    defaultValue: field.defaultValue,
  };
  if (field.type === "enum") base.options = field.options ?? [];
  if (field.type === "password") {
    base.value = "";
    base.configured = typeof overrides[field.key] === "string" && overrides[field.key] !== "";
  } else {
    base.value = field.key in overrides ? overrides[field.key] : field.defaultValue;
  }
  return base;
}

/**
 * 通用设置端点处理器:GET 返回 token 状态 + 字段状态;POST 接收
 * `{ token?, fields? }`。tokenEnv 缺省时跳过 token 部分。
 */
export async function handleModuleSettings(
  ctx: TrioContext,
  req: IncomingMessage,
  res: ServerResponse,
  section: string,
  spec: FieldSpec[],
  tokenEnv?: string,
  label?: string,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "GET") {
    const payload: Record<string, unknown> = { section };
    if (tokenEnv !== undefined) payload.token = await credentialStatus(ctx, tokenEnv, label);
    payload.fields = spec.map((f) => fieldState(f, sectionOverrides(section, spec)));
    sendJson(res, 200, payload);
    return;
  }
  if (method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readRawBody(req, 16 * 1024)) || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    try {
      if (tokenEnv !== undefined && body.token !== undefined) {
        const checked = validateCredentialValue(body.token);
        if (typeof checked === "object") throw new Error(checked.error);
        await writeCredential(ctx, tokenEnv, checked);
      }
      if (body.fields !== undefined) {
        if (body.fields === null || typeof body.fields !== "object" || Array.isArray(body.fields)) {
          throw new Error("fields must be an object");
        }
        await writeSettingsSection(section, body.fields as Record<string, unknown>, spec);
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const payload: Record<string, unknown> = { ok: true, section };
    if (tokenEnv !== undefined) payload.token = await credentialStatus(ctx, tokenEnv, label);
    payload.fields = spec.map((f) => fieldState(f, sectionOverrides(section, spec)));
    sendJson(res, 200, payload);
    return;
  }
  sendText(res, 405, "method not allowed");
}

/** 注册 exact 路由 `${base}/settings`(供无前缀路由冲突的模块使用)。 */
export function registerModuleSettingsRoute(
  ctx: TrioContext,
  base: string,
  section: string,
  spec: FieldSpec[],
  tokenEnv?: string,
  label?: string,
): () => void {
  const webServer = ctx.get<{ register(route: WebRoute): () => void }>("webServer");
  if (webServer === undefined) return () => {};
  const settingsPath = `${base.replace(/\/+$/, "")}/settings`;
  const dispose = webServer.register({
    kind: "exact",
    path: settingsPath,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void handleModuleSettings(ctx, req, res, section, spec, tokenEnv, label).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    },
  });
  return dispose;
}
