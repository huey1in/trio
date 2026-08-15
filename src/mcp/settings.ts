// dsh-trio · MCP — 面板设置字段白名单
import type { FieldSpec } from "../lib/settings.js";

export const MCP_SETTING_FIELDS: FieldSpec[] = [
  { key: "authToken", label: "访问 token(Bearer,空=不鉴权)", type: "password", defaultValue: "" },
  { key: "path", label: "MCP 端点路径", type: "string", restart: true, defaultValue: "/trio/mcp" },
];
