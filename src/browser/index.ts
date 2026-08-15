// dsh-trio · 浏览器自动化
//
// 一个共享的 Playwright 浏览器会话(agent 通过工具控制,人在原生界面
// 右下角面板旁观:缩略图点开大屏模态框,含实时画面与访问历史)。
// 仅依赖 playwright-core:优先使用系统已装的 Edge/Chrome(channel
// 自动探测),无需下载 Chromium。
//
// 工具集:browser_open / browser_snapshot / browser_click / browser_type /
// browser_press / browser_eval / browser_screenshot / browser_wait /
// browser_back / browser_reload / browser_status / browser_close。

import type { TrioContext } from "../lib/types.js";
import type { BrowserConfig } from "./types.js";
import { resolveConfig, type ConfigSchema } from "../lib/config.js";
import { registerTools } from "./register.js";
import { registerBrowserApi } from "./ui.js";
import { closeBrowser, sweepScreenshotDir } from "./session.js";

export type { BrowserConfig } from "./types.js";
export { profileConfig } from "./session.js";

export const name = "trio-browser";
export const inject = ["tools"];
const BROWSER_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  channel: { type: "string" },
  executablePath: { type: "string" },
  headless: { type: "boolean" },
  userDataDir: { type: "string" },
  profiles: { type: "any" },
  screenshotDir: { type: "string" },
  downloadDir: { type: "string" },
  screenshotMaxAgeDays: { type: "number", min: 0 },
  screenshotMaxCount: { type: "number", min: 0 },
  liveViewPath: { type: "string" },
  maxTextChars: { type: "number", min: 1 },
  maxLinks: { type: "number", min: 1 },
  timeoutMs: { type: "number", min: 1 },
};

const DEFAULT_CONFIG = {
  channel: "auto", // 'auto' | 'chrome' | 'msedge' | 'chromium' | '' (playwright default)
  executablePath: "", // explicit browser executable (wins over channel)
  headless: true,
  userDataDir: "", // 设置后登录态(Cookie/localStorage)持久化到该目录,跨 DSH 重启保留
  profiles: {}, // 命名浏览器配置: { work: { userDataDir, channel, headless }, personal: {...} }
  screenshotDir: ".dsh-trio/screenshots",
  downloadDir: ".dsh-trio/downloads",
  screenshotMaxAgeDays: 7, // 截图保留天数(0 = 不按时间清理)
  screenshotMaxCount: 200, // 截图保留数量上限(0 = 不按数量清理)
  liveViewPath: "/trio/browser",
  maxTextChars: 20000,
  maxLinks: 50,
  timeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// 共享浏览器会话(模块级单例;插件 dispose 时关闭)
// ---------------------------------------------------------------------------

/**
 * 多配置文件浏览器会话。每个命名 profile(含默认 "default")独立隔离:
 * 浏览器实例、标签页表、登录态(userDataDir)。插件 dispose 时全部关闭。
 */

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("browser", BROWSER_SCHEMA, DEFAULT_CONFIG, rawConfig) as BrowserConfig;
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const tools = ctx.get("tools");
  if (tools === undefined) return;
  registerTools(ctx, config);
  const systemPrompt = ctx.get<{
    section(section: { name: string; order?: number; text: string }): () => void;
  }>("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:browser",
    order: 200,
    text: "浏览器工具操作一个共享浏览器会话,支持多标签页。打开页面后先用 browser_snapshot 读文本与链接、browser_elements 读表单结构,再决定 browser_click / browser_type / browser_form;标签管理用 browser_tabs;下载用 browser_download;登录态用 browser_cookies;需要用户查看画面时用 browser_screenshot 保存截图并说明路径。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
  registerBrowserApi(ctx, config);
  // 截图目录定时清扫:每小时一次(懒清理在每次截图后已即时执行)。
  const sweepTimer = setInterval(() => {
    try {
      sweepScreenshotDir({
        maxAgeDays: config.screenshotMaxAgeDays,
        maxCount: config.screenshotMaxCount,
      });
    } catch {
      /* ignore */
    }
  }, 60 * 60 * 1000);
  sweepTimer.unref?.();
  ctx.effect(() => () => {
    clearInterval(sweepTimer);
    void closeBrowser().catch(() => {});
  });
}

