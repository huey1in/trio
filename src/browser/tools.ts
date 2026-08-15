// dsh-reef · 浏览器 — 工具实现(22 个 browser_* 函数)
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { Page } from "playwright-core";
import type { ToolRunContext } from "../lib/types.js";
import type { BrowserConfig, FormField } from "./types.js";
import {
  profileConfig, getProfileState, downloadsOf, launchProfile, newPage,
  getPage, activePage, tabList, closeBrowser, pageIdentity, stateOf,
  currentProfile, savedForms, lastFormFields, profileStates, setLastFormFields, setCurrentProfile,
  noteScreenshotDir, cleanupScreenshots, browserOverrides,
} from "./session.js";
import { workspaceCwd } from "../lib/tools.js";
export async function openTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  await page.goto(String(args.url), {
    waitUntil: args.waitUntil ?? "domcontentloaded",
    timeout: args.timeoutMs ?? config.timeoutMs,
  });
  return {
    url: page.url(),
    title: await page.title(),
    status: "ok",
  };
}

export async function snapshotTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const maxText = args.maxTextChars ?? config.maxTextChars;
  const maxLinks = args.maxLinks ?? config.maxLinks;
  const data = await page.evaluate(
    ([maxT, maxL]) => {
      const text = document.body ? document.body.innerText : "";
      const links = Array.from(document.querySelectorAll("a"))
        .slice(0, maxL)
        .map((a) => ({
          text: (a.innerText || a.textContent || "").trim().slice(0, 200),
          href: a.href,
        }));
      const inputs = document.querySelectorAll("input, textarea, select").length;
      return { text: text.slice(0, maxT), truncated: text.length > maxT, links, inputs };
    },
    [maxText, maxLinks],
  );
  return {
    url: page.url(),
    title: await page.title(),
    ...data,
  };
}

export async function clickTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const selector = String(args.selector);
  await page.click(selector, { timeout: args.timeoutMs ?? config.timeoutMs });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return {
    clicked: selector,
    ...(await pageIdentity(page)),
  };
}

export async function typeTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const selector = String(args.selector);
  const text = String(args.text ?? "");
  if (args.clear === true) {
    await page.fill(selector, text, { timeout: args.timeoutMs ?? config.timeoutMs });
  } else {
    await page.click(selector, { timeout: args.timeoutMs ?? config.timeoutMs });
    await page.keyboard.type(text, { delay: args.delayMs ?? 0 });
  }
  if (args.submit === true) await page.keyboard.press("Enter");
  return {
    typed: true,
    selector,
    submit: args.submit === true,
    ...(await pageIdentity(page)),
  };
}

export async function pressTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const key = String(args.key);
  if (args.selector) {
    await page.press(String(args.selector), key, {
      timeout: args.timeoutMs ?? config.timeoutMs,
    });
  } else {
    await page.keyboard.press(key);
  }
  return { pressed: key, ...(await pageIdentity(page)) };
}

export async function evalTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const script = String(args.script ?? "");
  // 表达式优先;含语句(换行/分号/return)时包成 async IIFE。
  const wrapped = /[\n;]|^\s*return\b/.test(script)
    ? `(async () => {\n${script}\n})()`
    : `(${script})`;
  const raw = await page.evaluate(wrapped);
  // 净化成 lossless JSON:去掉原型链/函数/DOM 引用,无法序列化的降级为字符串。
  let result: unknown;
  try {
    result = JSON.parse(JSON.stringify(raw ?? null));
  } catch {
    result = raw === undefined ? null : String(raw);
  }
  return { result };
}

export async function screenshotTool(config: BrowserConfig, args: Record<string, any>, exec: ToolRunContext) {
  const page = await getPage(config);
  const cwd = workspaceCwd(exec);
  // 面板运行时覆盖:screenshotDir / 清理参数即时生效。
  const ov = browserOverrides();
  const screenshotDir =
    typeof ov.screenshotDir === "string" && ov.screenshotDir
      ? ov.screenshotDir
      : (config.screenshotDir ?? ".dsh-reef/screenshots");
  const dir = isAbsolute(screenshotDir) ? screenshotDir : resolve(cwd, screenshotDir);
  mkdirSync(dir, { recursive: true });
  const safeName = String(args.name ?? `shot-${Date.now()}`).replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  const fileName = safeName.endsWith(".png") ? safeName : `${safeName}.png`;
  const filePath = join(dir, fileName);
  const buffer = await page.screenshot({ type: "png" });
  writeFileSync(filePath, buffer);
  // 懒清理:按保留天数/数量修剪目录,并把目录记下供定时清扫复用。
  noteScreenshotDir(dir);
  cleanupScreenshots(dir, {
    maxAgeDays: typeof ov.screenshotMaxAgeDays === "number" ? ov.screenshotMaxAgeDays : config.screenshotMaxAgeDays,
    maxCount: typeof ov.screenshotMaxCount === "number" ? ov.screenshotMaxCount : config.screenshotMaxCount,
  });
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  return {
    path: filePath,
    bytes: buffer.length,
    width: viewport.width,
    height: viewport.height,
  };
}

export async function waitTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const ms = Math.max(0, Math.min(Number(args.ms ?? 1000) || 0, 60000));
  await page.waitForTimeout(ms);
  return { waitedMs: ms, ...(await pageIdentity(page)) };
}

export async function backTool(config: BrowserConfig) {
  const page = await getPage(config);
  await page.goBack().catch(() => {});
  return { ...(await pageIdentity(page)) };
}

export async function reloadTool(config: BrowserConfig) {
  const page = await getPage(config);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  return { ...(await pageIdentity(page)) };
}

export async function statusTool() {
  const page = activePage();
  const state = stateOf();
  const profiles = [];
  for (const [name, s] of profileStates) {
    profiles.push({
      name,
      open: s.browser !== null || s.context !== null,
      tabs: s.pages.size,
      channel: s.channel ?? "",
      persistent: s.persistent,
    });
  }
  if (page === null) {
    return { open: false, profile: currentProfile, channel: state.channel ?? "", tabs: 0, profiles };
  }
  return {
    open: true,
    profile: currentProfile,
    channel: state.channel ?? "",
    tabs: state.pages.size,
    profiles,
    ...(await pageIdentity(page)),
  };
}

export async function tabsTool(config: BrowserConfig, args: Record<string, any>) {
  const action = args.action ?? "list";
  const state = stateOf();
  if (state.browser === null && state.context === null && action !== "list") await launchProfile(currentProfile, config);
  if (state.browser === null && state.context === null) return { action, tabs: [], activeId: -1 };
  switch (action) {
    case "list": {
      return { action, tabs: await tabList(), activeId: state.activeId ?? -1 };
    }
    case "new": {
      const page = await newPage(config);
      const id = state.counter++;
      state.pages.set(id, page);
      state.activeId = id;
      if (args.url) {
        await page.goto(String(args.url), {
          waitUntil: args.waitUntil ?? "domcontentloaded",
          timeout: args.timeoutMs ?? config.timeoutMs,
        });
      }
      return { action, tab: { id, url: page.url(), title: await page.title() }, tabs: await tabList(), activeId: state.activeId };
    }
    case "switch": {
      const id = resolveTabId(args);
      if (!state.pages.has(id)) throw new Error(`no tab with id ${id}`);
      state.activeId = id;
      return { action, activeId: state.activeId, tabs: await tabList() };
    }
    case "close": {
      const id = resolveTabId(args);
      const page = state.pages.get(id);
      if (page === undefined) throw new Error(`no tab with id ${id}`);
      await page.close().catch(() => {});
      state.pages.delete(id);
      if (state.activeId === id) {
        const next = state.pages.keys().next().value;
        state.activeId = next === undefined ? null : next;
      }
      return { action, activeId: state.activeId ?? -1, tabs: await tabList() };
    }
    default:
      throw new Error(`unknown tabs action: ${action}`);
  }
}

export function resolveTabId(args: Record<string, any>): number {
  const state = stateOf();
  if (args.id !== undefined) return Number(args.id);
  if (args.index !== undefined) {
    const ids = [...state.pages.keys()];
    const idx = Number(args.index);
    if (idx < 0 || idx >= ids.length) throw new Error(`tab index ${idx} out of range`);
    return ids[idx];
  }
  if (state.activeId !== null) return state.activeId;
  throw new Error("no tab id/index given and no active tab");
}

export async function downloadTool(config: BrowserConfig, args: Record<string, any>, exec: ToolRunContext) {
  const recentDownloads = downloadsOf(currentProfile);
  if (recentDownloads.length === 0) {
    throw new Error("no recent downloads. Trigger a download in the page first (e.g. browser_click on a download link).");
  }
  const index = args.index !== undefined ? Number(args.index) : recentDownloads.length - 1;
  const entry = recentDownloads[index];
  if (entry === undefined) throw new Error(`no download at index ${index}`);
  const cwd = workspaceCwd(exec);
  const downloadDir = config.downloadDir ?? ".dsh-reef/downloads";
  const dir = isAbsolute(downloadDir) ? downloadDir : resolve(cwd, downloadDir);
  mkdirSync(dir, { recursive: true });
  const safe = String(entry.suggestedFilename || `download-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "_");
  const filePath = join(dir, safe);
  if (!filePath.startsWith(resolve(dir))) throw new Error(`download path escapes directory: ${filePath}`);
  await entry.download.saveAs(filePath);
  return {
    path: filePath,
    filename: safe,
    url: entry.download.url() ?? "",
    bytes: statSync(filePath).size,
  };
}

export async function uploadTool(config: BrowserConfig, args: Record<string, any>, exec: ToolRunContext) {
  const page = await getPage(config);
  const cwd = workspaceCwd(exec);
  const filePath = isAbsolute(args.path) ? String(args.path) : resolve(cwd, String(args.path));
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  const resolvedPath = resolve(filePath);
  await page.setInputFiles(String(args.selector), resolvedPath, {
    timeout: args.timeoutMs ?? config.timeoutMs,
  });
  return {
    uploaded: filePath,
    bytes: stat.size,
    ...(await pageIdentity(page)),
  };
}

export async function cookiesTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const context = page.context();
  const action = args.action ?? "list";
  if (action === "list") {
    const cookies = await context.cookies(args.url ?? page.url());
    return {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: args.showValues === true ? c.value : "(hidden — set showValues=true to reveal)",
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expires: c.expires,
      })),
    };
  }
  if (action === "set") {
    if (!args.name || args.value === undefined) throw new Error("set requires name and value");
    await context.addCookies([
      { name: String(args.name), value: String(args.value), url: args.url ?? page.url() },
    ]);
    return { set: true, name: String(args.name), url: args.url ?? page.url() };
  }
  if (action === "clear") {
    await context.clearCookies();
    return { cleared: true };
  }
  throw new Error(`unknown cookies action: ${action}`);
}

export async function formTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  let fields = args.fields ?? [];
  if (!Array.isArray(fields) || fields.length === 0) {
    // 回放已保存的表单
    if (typeof args.from === "string" && savedForms.has(args.from)) {
      fields = savedForms.get(args.from);
    } else {
      throw new Error("fields must be a non-empty array (or pass from=<saved form name>)");
    }
  }
  const filled = [];
  for (const field of fields) {
    const value = String(field.value ?? "");
    if (field.selector) {
      await page.fill(String(field.selector), value, { timeout: args.timeoutMs ?? config.timeoutMs });
      filled.push({ selector: field.selector });
    } else if (field.label) {
      await page.getByLabel(String(field.label), { exact: true }).fill(value);
      filled.push({ label: field.label });
    } else {
      throw new Error("each field needs a selector or a label");
    }
  }
  setLastFormFields(fields.map((f: FormField) => ({ ...f })));
  if (args.submit === true) await page.keyboard.press("Enter");
  return {
    filled,
    submit: args.submit === true,
    ...(await pageIdentity(page)),
  };
}

export async function formSaveTool(args: Record<string, any>) {
  let fields: FormField[] = args.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    if (lastFormFields.length === 0) {
      throw new Error("no fields given and no previous browser_form to remember");
    }
    fields = lastFormFields;
  }
  const name = String(args.name ?? "");
  if (!name) throw new Error("name is required");
  savedForms.set(name, fields.map((f: FormField) => ({ ...f })));
  return { saved: name, fields: fields.length };
}

export async function formsTool(args: Record<string, any>) {
  const action = args.action ?? "list";
  if (action === "list") {
    return {
      forms: [...savedForms.entries()].map(([name, fields]) => ({
        name,
        fields: fields.length,
        preview: fields
          .slice(0, 3)
          .map((f: FormField) => f.selector ?? f.label ?? "?")
          .join(", "),
      })),
    };
  }
  if (action === "delete") {
    if (!args.name) throw new Error("name is required");
    const existed = savedForms.delete(String(args.name));
    return { deleted: existed, name: String(args.name) };
  }
  throw new Error(`unknown forms action: ${action}`);
}

export async function profileTool(config: BrowserConfig, args: Record<string, any>) {
  const action = args.action ?? "list";
  const available = Object.keys(config.profiles ?? {});
  // 与 outputSchema 保持一致:profiles 永远是对象数组,不随动作变化。
  const describe = (name: string) => {
    const state = getProfileState(name);
    return {
      name,
      open: state.browser !== null || state.context !== null,
      tabs: state.pages.size,
      persistent: state.persistent,
      userDataDir: profileConfig(config, name).userDataDir ?? "",
    };
  };
  if (action === "list") {
    return { current: currentProfile, profiles: available.map(describe) };
  }
  if (action === "use") {
    const name = String(args.name ?? "");
    if (name !== "default" && !available.includes(name)) {
      throw new Error(`unknown profile: ${name} (available: ${["default", ...available].join(", ")})`);
    }
    setCurrentProfile(name);
    return { current: currentProfile, profiles: available.map(describe) };
  }
  throw new Error(`unknown profile action: ${action}`);
}

export async function elementsTool(config: BrowserConfig, args: Record<string, any>) {
  const page = await getPage(config);
  const max = Math.min(Math.max(Number(args.max ?? 60) || 60, 1), 200);
  const elements = await page.evaluate((maxN: number) => {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const nodes = Array.from(
      document.querySelectorAll("input, textarea, select, button, a[href]"),
    ) as HTMLElement[];
    for (const el of nodes) {
      if (out.length >= maxN) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const info = {
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? "",
        name: (el as HTMLInputElement).name ?? "",
        id: el.id ?? "",
        placeholder: (el as HTMLInputElement).placeholder ?? "",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 80),
        href: (el as HTMLAnchorElement).href ?? "",
        selector:
          el.id !== ""
            ? `#${CSS.escape(el.id)}`
            : (el as HTMLInputElement).name !== ""
              ? `${el.tagName.toLowerCase()}[name="${(el as HTMLInputElement).name}"]`
              : "",
      };
      const key = `${info.tag}|${info.name}|${info.id}|${info.placeholder}|${info.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(info);
    }
    return out;
  }, max);
  return { count: elements.length, elements };
}

export async function closeTool() {
  await closeBrowser();
  return { closed: true };
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

