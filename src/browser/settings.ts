// dsh-reef · 浏览器 — 面板设置字段白名单
import type { FieldSpec } from "../lib/settings.js";

export const BROWSER_SETTING_FIELDS: FieldSpec[] = [
  { key: "headless", label: "无头模式", type: "boolean", defaultValue: true },
  { key: "channel", label: "浏览器通道", type: "enum", options: ["auto", "msedge", "chrome", "chromium"], defaultValue: "auto" },
  { key: "screenshotDir", label: "截图目录", type: "string", defaultValue: ".dsh-reef/screenshots" },
  { key: "screenshotMaxAgeDays", label: "截图保留天数(0=不按时间清理)", type: "number", defaultValue: 7 },
  { key: "screenshotMaxCount", label: "截图保留数量(0=不按数量清理)", type: "number", defaultValue: 200 },
  { key: "timeoutMs", label: "操作超时(毫秒)", type: "number", defaultValue: 30000 },
  { key: "liveViewPath", label: "实时画面 API 路径", type: "string", restart: true, defaultValue: "/reef/browser" },
];
