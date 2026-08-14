// 配置校验器:轻量 schema 校验(运行时零依赖)。
// 每个模块导出 configSchema 描述,apply 前校验并给出中文错误信息。

export interface FieldSchema {
  type: "string" | "number" | "boolean" | "array" | "object" | "string[]" | "any";
  optional?: boolean;
  default?: unknown;
  enum?: string[];
  items?: FieldSchema;
  max?: number;
  min?: number;
}

export type ConfigSchema = Record<string, FieldSchema>;

const TYPES = ["string", "number", "boolean", "array", "object", "string[]", "any"];

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function checkField(key: string, value: unknown, schema: FieldSchema, errors: string[]) {
  if (value === undefined || value === null) {
    if (!schema.optional) errors.push(`config.${key}: 必填但缺失`);
    return;
  }
  const t = typeOf(value);
  if (schema.type === "any") return;
  if (schema.type === "string[]") {
    if (t !== "array" || !(value as unknown[]).every((v) => typeof v === "string")) {
      errors.push(`config.${key}: 期望 string[] 实际 ${t}`);
    }
    return;
  }
  if (t !== schema.type) {
    errors.push(`config.${key}: 期望 ${schema.type} 实际 ${t}`);
    return;
  }
  if (schema.type === "number") {
    const n = value as number;
    if (schema.max !== undefined && n > schema.max) errors.push(`config.${key}: 超过上限 ${schema.max}`);
    if (schema.min !== undefined && n < schema.min) errors.push(`config.${key}: 低于下限 ${schema.min}`);
  }
  if (schema.type === "string" && schema.enum !== undefined && !schema.enum.includes(value as string)) {
    errors.push(`config.${key}: 必须是 ${schema.enum.join(" / ")} 之一`);
  }
}

/** 校验配置;返回错误列表(空 = 通过)。 */
export function validateConfig(schema: ConfigSchema, config: Record<string, any>): string[] {
  const errors: string[] = [];
  for (const [key, field] of Object.entries(schema)) {
    checkField(key, config[key], field, errors);
  }
  return errors;
}

/** 合并默认值 + 校验;抛错时带模块名前缀。 */
export function resolveConfig(
  moduleName: string,
  schema: ConfigSchema,
  defaults: Record<string, any>,
  raw: Record<string, any> | undefined,
): Record<string, any> {
  const config: Record<string, any> = { ...defaults, ...(raw ?? {}) };
  for (const [key, field] of Object.entries(schema)) {
    if (field.default !== undefined && config[key] === undefined) config[key] = field.default;
  }
  const errors = validateConfig(schema, config);
  if (errors.length > 0) {
    throw new Error(`dsh-trio/${moduleName}: 配置无效 — ${errors.join("; ")}`);
  }
  return config;
}

export { TYPES };
