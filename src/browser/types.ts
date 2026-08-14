// dsh-trio · 浏览器 — 类型定义
import type { Browser, BrowserContext, Page } from "playwright-core";

export interface BrowserConfig {
  enabled?: boolean;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  userDataDir?: string;
  profiles?: Record<string, Partial<BrowserConfig>>;
  screenshotDir?: string;
  downloadDir?: string;
  liveViewPath?: string;
  maxTextChars?: number;
  maxLinks?: number;
  timeoutMs?: number;
}

/** 一个命名 profile 的会话状态。 */
export interface ProfileState {
  browser: Browser | null;
  context: BrowserContext | null;
  persistent: boolean;
  pages: Map<number, Page>;
  activeId: number | null;
  counter: number;
  channel?: string;
}

/** 一次页面下载的记录。 */
export interface DownloadEntry {
  download: {
    saveAs(path: string): Promise<void>;
    suggestedFilename(): string;
    url(): string;
  };
  suggestedFilename: string;
  at: number;
}

/** 表单字段(selector 或 label 二选一)。 */
/** 表单字段(selector 或 label 二选一)。 */
export interface FormField {
  selector?: string;
  label?: string;
  value?: string;
}
