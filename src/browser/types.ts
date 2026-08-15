// dsh-reef · 浏览器 — 类型定义
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
  /** 截图保留天数(0 = 不按时间清理)。 */
  screenshotMaxAgeDays?: number;
  /** 截图保留数量上限(0 = 不按数量清理)。 */
  screenshotMaxCount?: number;
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

/** 一次页面访问(导航)的记录,供实时画面模态框展示访问历史。 */
export interface NavEntry {
  url: string;
  title: string;
  ts: number;
}

/** 表单字段(selector 或 label 二选一)。 */
export interface FormField {
  selector?: string;
  label?: string;
  value?: string;
}
