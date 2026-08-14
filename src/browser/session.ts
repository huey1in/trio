// dsh-trio · 浏览器 — 会话与标签页管理(多 profile、userDataDir 持久化、下载记录)
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BrowserConfig, ProfileState, DownloadEntry, FormField } from "./types.js";

/** 当前活动 profile 名(默认 "default")。 */
export let currentProfile = "default";
/** 多配置文件浏览器会话:name → 会话状态。 */
export const profileStates = new Map<string, ProfileState>();
/** 最近下载记录 [{ download, suggestedFilename, at }](按 profile 名隔离)。 */
const downloadsByProfile = new Map<string, DownloadEntry[]>();
/** 已保存的表单回放:name → fields 数组。 */
export const savedForms = new Map<string, FormField[]>();
/** 最近一次 browser_form 填充的字段(供 browser_form_save 无参保存)。 */
export let lastFormFields: FormField[] = [];

export function profileConfig(config: BrowserConfig, name: string): BrowserConfig {
  const named = config.profiles?.[name];
  if (!named || typeof named !== "object") return { ...config };
  return {
    ...config,
    ...named,
    profiles: config.profiles,
  };
}

export function getProfileState(name: string): ProfileState {
  let state = profileStates.get(name);
  if (state === undefined) {
    state = { browser: null, context: null, persistent: false, pages: new Map(), activeId: null, counter: 0 };
    profileStates.set(name, state);
  }
  return state;
}

export function downloadsOf(name: string): DownloadEntry[] {
  let list = downloadsByProfile.get(name);
  if (list === undefined) {
    list = [];
    downloadsByProfile.set(name, list);
  }
  return list;
}

export function attachPage(page: Page, config: BrowserConfig): void {
  page.setDefaultTimeout(config.timeoutMs ?? 30000);
  page.on("download", (download) => {
    const list = downloadsOf(currentProfile);
    list.push({ download, suggestedFilename: download.suggestedFilename(), at: Date.now() });
    if (list.length > 20) list.shift();
  });
}

export async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  try {
    return await import("playwright-core");
  } catch {
    throw new Error(
      "dsh-trio/browser: playwright-core is not installed. Run `dsh plugin --profile web add playwright-core` or install it in the profile.",
    );
  }
}

interface LaunchCandidate {
  headless: boolean;
  channel?: string;
  executablePath?: string;
}

export async function launchProfile(name: string, config: BrowserConfig): Promise<void> {
  const pw = await loadPlaywright();
  const state = getProfileState(name);
  const resolved = profileConfig(config, name);
  const base: LaunchCandidate = { headless: resolved.headless ?? true };
  const candidates: LaunchCandidate[] = [];
  if (resolved.executablePath) {
    candidates.push({ ...base, executablePath: resolved.executablePath });
  } else if (resolved.channel && resolved.channel !== "auto") {
    candidates.push({ ...base, channel: resolved.channel });
  } else {
    const order =
      process.platform === "win32"
        ? ["msedge", "chrome", "chromium"]
        : ["chrome", "msedge", "chromium"];
    for (const channel of order) candidates.push({ ...base, channel });
    candidates.push(base); // playwright's own bundled chromium fallback
  }
  let lastError: unknown;
  for (const options of candidates) {
    try {
      if (resolved.userDataDir) {
        // 持久化配置文件目录:登录态(Cookie/localStorage)跨重启保留
        const context = await pw.chromium.launchPersistentContext(resolved.userDataDir, {
          ...options,
          headless: resolved.headless ?? true,
        });
        for (const existing of context.pages()) {
          existing.close().catch(() => {});
        }
        state.browser = null;
        state.context = context;
        state.persistent = true;
        state.channel = options.channel ?? options.executablePath ?? "bundled";
        return;
      }
      const browser = await pw.chromium.launch(options);
      state.browser = browser;
      state.context = null;
      state.persistent = false;
      state.channel = options.channel ?? options.executablePath ?? "bundled";
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `dsh-trio/browser: could not launch a Chromium-based browser. ` +
      `Install one, set config executablePath, or run \`npx playwright install chromium\`. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 当前 profile 状态(未启动时创建空状态)。 */
export function stateOf(): ProfileState {
  return getProfileState(currentProfile);
}

/** 新建一个页面(当前 profile 会话未启动时先启动)。 */
export async function newPage(config: BrowserConfig): Promise<Page> {
  const state = stateOf();
  const resolved = profileConfig(config, currentProfile);
  if (state.browser === null && state.context === null) await launchProfile(currentProfile, config);
  const context = state.context;
  const browser = state.browser;
  if (context !== null) {
    const page = await context.newPage();
    attachPage(page, config);
    return page;
  }
  if (browser !== null) {
    const page = await browser.newPage();
    attachPage(page, config);
    return page;
  }
  throw new Error("dsh-trio/browser: browser session failed to start");
}

/** 返回当前活动页面(没有则新建),并保证浏览器已启动。 */
export async function getPage(config: BrowserConfig): Promise<Page> {
  const state = stateOf();
  if (state.browser === null && state.context === null) await launchProfile(currentProfile, config);
  if (state.pages.size === 0) {
    const page = await newPage(config);
    const id = state.counter++;
    state.pages.set(id, page);
    state.activeId = id;
  }
  const page = state.pages.get(state.activeId ?? -1);
  if (page === undefined) throw new Error("dsh-trio/browser: no active page");
  return page;
}

/** 活动页面(可能为 null,不触发启动)。 */
export function activePage(): Page | null {
  const state = stateOf();
  return state.pages.get(state.activeId ?? -1) ?? null;
}

/** 投影当前 profile 的标签列表。 */
export async function tabList() {
  const state = stateOf();
  const tabs = [];
  for (const [id, page] of state.pages) {
    let title = "";
    try {
      title = await page.title();
    } catch {
      /* closed */
    }
    tabs.push({ id, url: page.url(), title });
  }
  return tabs;
}

export async function closeBrowser(): Promise<void> {
  for (const [name, state] of profileStates) {
    const { browser, context } = state;
    state.browser = null;
    state.context = null;
    state.pages = new Map();
    state.activeId = null;
    state.counter = 0;
    try {
      if (context !== null) {
        await context.close();
      } else if (browser !== null) {
        await browser.close();
      }
    } catch {
      /* already closed */
    }
    void name;
  }
  profileStates.clear();
  downloadsByProfile.clear();
}

/** Best-effort current page identity, safe when nothing is open. */

export async function pageIdentity(page: Page) {
  try {
    return {
      url: page.url(),
      title: await page.title(),
    };
  } catch {
    return { url: "", title: "" };
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------


/** 设置最近一次表单填充(供 browser_form_save 无参保存)。 */
export function setLastFormFields(fields: FormField[]): void {
  lastFormFields = fields;
}

/** 切换当前 profile。 */
export function setCurrentProfile(name: string): void {
  currentProfile = name;
}
