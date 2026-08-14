// dsh-trio · 浏览器自动化
//
// 一个共享的 Playwright 浏览器会话(agent 通过工具控制,人在 /trio/browser
// 实时画面页旁观)。仅依赖 playwright-core:优先使用系统已装的
// Edge/Chrome(channel 自动探测),无需下载 Chromium。
//
// 工具集:browser_open / browser_snapshot / browser_click / browser_type /
// browser_press / browser_eval / browser_screenshot / browser_wait /
// browser_back / browser_reload / browser_status / browser_close。

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { definePlainTool, genericCard, workspaceCwd } from "./lib/tools.js";
import { urlPath, sendText, sendJson } from "./lib/http.js";

export const name = "trio-browser";
export const inject = ["tools"];

const DEFAULT_CONFIG = {
  channel: "auto", // 'auto' | 'chrome' | 'msedge' | 'chromium' | '' (playwright default)
  executablePath: "", // explicit browser executable (wins over channel)
  headless: true,
  screenshotDir: ".dsh-trio/screenshots",
  liveViewPath: "/trio/browser",
  maxTextChars: 20000,
  maxLinks: 50,
  timeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// 共享浏览器会话(模块级单例;插件 dispose 时关闭)
// ---------------------------------------------------------------------------

/** @type {import('playwright-core').Browser | null} */
let sharedBrowser = null;
/** @type {import('playwright-core').Page | null} */
let sharedPage = null;
/** @type {string | null} */
let browserChannel = null;

async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch {
    throw new Error(
      "dsh-trio/browser: playwright-core is not installed. Run `dsh plugin --profile web add playwright-core` or install it in the profile.",
    );
  }
}

async function launchBrowser(config) {
  const pw = await loadPlaywright();
  const base = { headless: config.headless };
  const candidates = [];
  if (config.executablePath) {
    candidates.push({ ...base, executablePath: config.executablePath });
  } else if (config.channel && config.channel !== "auto") {
    candidates.push({ ...base, channel: config.channel });
  } else {
    const order =
      process.platform === "win32"
        ? ["msedge", "chrome", "chromium"]
        : ["chrome", "msedge", "chromium"];
    for (const channel of order) candidates.push({ ...base, channel });
    candidates.push(base); // playwright's own bundled chromium fallback
  }
  let lastError;
  for (const options of candidates) {
    try {
      const browser = await pw.chromium.launch(options);
      browserChannel = options.channel ?? options.executablePath ?? "bundled";
      return browser;
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

async function getPage(config) {
  if (sharedBrowser === null) sharedBrowser = await launchBrowser(config);
  if (sharedPage === null || sharedPage.isClosed()) {
    sharedPage = await sharedBrowser.newPage();
    sharedPage.setDefaultTimeout(config.timeoutMs);
  }
  return sharedPage;
}

async function closeBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = null;
  sharedPage = null;
  browserChannel = null;
  if (browser !== null) {
    try {
      await browser.close();
    } catch {
      /* already closed */
    }
  }
}

/** Best-effort current page identity, safe when nothing is open. */
async function pageIdentity(page) {
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

async function openTool(config, args) {
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

async function snapshotTool(config, args) {
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

async function clickTool(config, args) {
  const page = await getPage(config);
  const selector = String(args.selector);
  await page.click(selector, { timeout: args.timeoutMs ?? config.timeoutMs });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return {
    clicked: selector,
    ...(await pageIdentity(page)),
  };
}

async function typeTool(config, args) {
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

async function pressTool(config, args) {
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

async function evalTool(config, args) {
  const page = await getPage(config);
  const script = String(args.script ?? "");
  // 表达式优先;含语句(换行/分号/return)时包成 async IIFE。
  const wrapped = /[\n;]|^\s*return\b/.test(script)
    ? `(async () => {\n${script}\n})()`
    : `(${script})`;
  const result = await page.evaluate(wrapped);
  return { result };
}

async function screenshotTool(config, args, exec) {
  const page = await getPage(config);
  const cwd = workspaceCwd(exec);
  const dir = isAbsolute(config.screenshotDir)
    ? config.screenshotDir
    : resolve(cwd, config.screenshotDir);
  mkdirSync(dir, { recursive: true });
  const safeName = String(args.name ?? `shot-${Date.now()}`).replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  const fileName = safeName.endsWith(".png") ? safeName : `${safeName}.png`;
  const filePath = join(dir, fileName);
  const buffer = await page.screenshot({ type: "png" });
  writeFileSync(filePath, buffer);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  return {
    path: filePath,
    bytes: buffer.length,
    width: viewport.width,
    height: viewport.height,
  };
}

async function waitTool(config, args) {
  const page = await getPage(config);
  const ms = Math.max(0, Math.min(Number(args.ms ?? 1000) || 0, 60000));
  await page.waitForTimeout(ms);
  return { waitedMs: ms, ...(await pageIdentity(page)) };
}

async function backTool(config) {
  const page = await getPage(config);
  await page.goBack().catch(() => {});
  return { ...(await pageIdentity(page)) };
}

async function reloadTool(config) {
  const page = await getPage(config);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  return { ...(await pageIdentity(page)) };
}

async function statusTool() {
  const page = sharedPage;
  if (page === null || page.isClosed()) {
    return { open: false, channel: browserChannel ?? "" };
  }
  return {
    open: true,
    channel: browserChannel ?? "",
    ...(await pageIdentity(page)),
  };
}

async function closeTool() {
  await closeBrowser();
  return { closed: true };
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

function registerTools(ctx, config) {
  const timeout = (ms) => ms ?? config.timeoutMs;
  ctx.tools.register(
    definePlainTool({
      name: "browser_open",
      description:
        "在共享浏览器中打开一个 URL。之后可用 browser_snapshot 读取页面内容,用 browser_click / browser_type / browser_eval 操作页面,用 browser_screenshot 截图。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的完整 URL(含协议)。" },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "commit"],
            description: "等待策略,默认 domcontentloaded。",
          },
          timeoutMs: { type: "integer", description: "等待超时(毫秒)。" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          status: { type: "string" },
        },
        required: ["url", "title", "status"],
      },
      render: (_args, value) => `Opened ${value.url}\nTitle: ${value.title}`,
      presentCall: (args) => genericCard("browser", String(args.url), String(args.url)),
      timeoutMs: timeout(),
      execute: (args) => openTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_snapshot",
      description:
        "读取当前页面的可访问文本、链接清单与输入框数量(不截图)。maxTextChars 默认 20000。链接列表用于构造点击选择器。",
      parameters: {
        type: "object",
        properties: {
          maxTextChars: { type: "integer", description: "文本截断上限。" },
          maxLinks: { type: "integer", description: "链接数量上限。" },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" },
          links: { type: "array", items: { type: "object" } },
          inputs: { type: "integer" },
        },
        required: ["url", "title", "text", "truncated", "links", "inputs"],
      },
      render: (_args, value) =>
        `URL: ${value.url}\nTitle: ${value.title}\nInputs: ${value.inputs}\n--- text ---\n${value.text}`,
      timeoutMs: timeout(),
      execute: (args) => snapshotTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_click",
      description: "点击页面上匹配 CSS 选择器的元素(来自 browser_snapshot 的链接/表单分析)。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器。" },
          timeoutMs: { type: "integer" },
        },
        required: ["selector"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          clicked: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["clicked", "url", "title"],
      },
      render: (_args, value) => `Clicked ${value.clicked}\nNow at: ${value.url}`,
      timeoutMs: timeout(),
      execute: (args) => clickTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_type",
      description:
        "向 CSS 选择器指向的输入框输入文本。clear=true 时先清空再输入(推荐用于表单);submit=true 时输入后按回车。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
          clear: { type: "boolean" },
          submit: { type: "boolean" },
          delayMs: { type: "integer" },
          timeoutMs: { type: "integer" },
        },
        required: ["selector", "text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          typed: { type: "boolean" },
          selector: { type: "string" },
          submit: { type: "boolean" },
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["typed", "selector", "submit", "url", "title"],
      },
      render: (_args, value) =>
        `Typed into ${value.selector}${value.submit ? " and submitted" : ""}\nNow at: ${value.url}`,
      timeoutMs: timeout(),
      execute: (args) => typeTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_press",
      description:
        "按键:有 selector 时先聚焦该元素再按键(如 'Enter'、'Tab'、'Escape'、'Control+a'),否则在页面级按键。",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "按键名(Playwright 键盘键名)。" },
          selector: { type: "string" },
          timeoutMs: { type: "integer" },
        },
        required: ["key"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pressed: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["pressed", "url", "title"],
      },
      render: (_args, value) => `Pressed ${value.pressed}`,
      timeoutMs: timeout(),
      execute: (args) => pressTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_eval",
      description:
        "在页面上下文执行一段 JavaScript。表达式直接求值(如 'document.title');含换行/分号的语句会被包进 async IIFE,可用 return 返回。结果必须是可 JSON 序列化的值。",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "要执行的 JavaScript。" },
        },
        required: ["script"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          result: {},
        },
        required: ["result"],
      },
      render: (_args, value) => `Result: ${JSON.stringify(value.result)}`,
      timeoutMs: timeout(),
      execute: (args) => evalTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_screenshot",
      description:
        "把当前页面截图保存为 PNG 文件(默认存到工作区 .dsh-trio/screenshots/),返回文件路径。纯文本模型看不到图,但用户可以在实时画面页查看。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "文件名(不含扩展名也会自动补 .png)。" },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          bytes: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
        required: ["path", "bytes", "width", "height"],
      },
      render: (args, value) => `Saved ${value.bytes} bytes → ${value.path}`,
      timeoutMs: timeout(),
      execute: (args, exec) => screenshotTool(config, args, exec),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_wait",
      description: "等待指定毫秒数(上限 60000),常用于等待页面渲染或请求完成。",
      parameters: {
        type: "object",
        properties: {
          ms: { type: "integer", description: "等待毫秒数,默认 1000。" },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          waitedMs: { type: "integer" },
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["waitedMs", "url", "title"],
      },
      render: (_args, value) => `Waited ${value.waitedMs}ms`,
      timeoutMs: timeout(),
      execute: (args) => waitTool(config, args),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_back",
      description: "返回上一页(如无历史则无操作)。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: "string" }, title: { type: "string" } },
        required: ["url", "title"],
      },
      render: (_args, value) => `Back to: ${value.url}`,
      timeoutMs: timeout(),
      execute: () => backTool(config),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_reload",
      description: "重新加载当前页面。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: "string" }, title: { type: "string" } },
        required: ["url", "title"],
      },
      render: (_args, value) => `Reloaded: ${value.url}`,
      timeoutMs: timeout(),
      execute: () => reloadTool(config),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_status",
      description: "查看浏览器会话是否打开、当前 URL 与标题。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          open: { type: "boolean" },
          channel: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["open", "channel", "url", "title"],
      },
      render: (_args, value) =>
        value.open ? `Open (${value.channel}): ${value.url} — ${value.title}` : "Not open",
      timeoutMs: timeout(),
      execute: () => statusTool(),
    }),
  );

  ctx.tools.register(
    definePlainTool({
      name: "browser_close",
      description: "关闭浏览器会话并释放资源;下次使用工具时会自动重新打开。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { closed: { type: "boolean" } },
        required: ["closed"],
      },
      render: () => "Browser closed",
      execute: () => closeTool(),
    }),
  );
}

const LIVE_VIEW_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Trio · 浏览器实时画面</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #21262d; position: sticky; top: 0; background: #0d1117; z-index: 1; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #status { font-size: 13px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #f85149; flex: none; }
  #dot.on { background: #3fb950; }
  main { padding: 12px; }
  img { width: 100%; max-width: 1280px; display: block; margin: 0 auto; border: 1px solid #21262d; border-radius: 8px; background: #010409; }
  .hint { text-align: center; color: #8b949e; font-size: 13px; padding: 40px 0; }
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <h1>🐋 DSH Trio · 浏览器实时画面</h1>
  <span id="status">加载中…</span>
</header>
<main>
  <img id="shot" alt="browser screenshot" style="display:none">
  <div id="empty" class="hint">浏览器尚未打开。让 agent 调用 browser_open,或稍候自动刷新。</div>
</main>
<script>
  const shot = document.getElementById('shot');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const dot = document.getElementById('dot');
  async function refresh() {
    try {
      const r = await fetch('./status', { cache: 'no-store' });
      const s = await r.json();
      if (s.open) {
        dot.className = 'on';
        status.textContent = (s.url || '(空白页)') + ' — ' + (s.title || '');
        shot.style.display = 'block';
        empty.style.display = 'none';
        shot.src = './screenshot?v=' + Date.now();
      } else {
        dot.className = '';
        status.textContent = '浏览器未打开(' + (s.channel || '未知') + ')';
        shot.style.display = 'none';
        empty.style.display = 'block';
      }
    } catch (e) {
      status.textContent = '连接失败: ' + e;
    }
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;

function registerLiveView(ctx, config) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = config.liveViewPath.replace(/\/+$/, "");
  const disposers = [];
  disposers.push(
    webServer.register({
      kind: "prefix",
      path: base,
      handler: async (req, res) => {
        const path = urlPath(req);
        if (path === base || path === `${base}/`) {
          sendText(res, 200, LIVE_VIEW_HTML, { "content-type": "text/html; charset=utf-8" });
          return;
        }
        if (path === `${base}/status`) {
          const state = await statusTool();
          sendJson(res, 200, state);
          return;
        }
        if (path === `${base}/screenshot`) {
          const page = sharedPage;
          if (page === null || page.isClosed()) {
            sendText(res, 404, "browser not open");
            return;
          }
          try {
            const buffer = await page.screenshot({ type: "png" });
            res.writeHead(200, {
              "content-type": "image/png",
              "cache-control": "no-store",
              "content-length": buffer.length,
            });
            res.end(buffer);
          } catch (error) {
            sendText(res, 500, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        sendText(res, 404, "not found");
      },
    }),
  );
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  });
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const tools = ctx.get("tools");
  if (tools === undefined) return;
  registerTools(ctx, config);
  const systemPrompt = ctx.get("systemPrompt");
  const sectionDispose = systemPrompt?.section?.({
    name: "tool:browser",
    order: 200,
    text: "浏览器工具(browser_open / browser_snapshot / browser_click / browser_type / browser_eval / browser_screenshot)操作一个共享浏览器会话。打开页面后用 browser_snapshot 读文本与链接,再决定点击/输入;需要用户查看画面时用 browser_screenshot 保存截图并说明路径。",
  });
  if (sectionDispose !== undefined) {
    ctx.effect(() => sectionDispose);
  }
  registerLiveView(ctx, config);
  ctx.effect(() => () => {
    void closeBrowser().catch(() => {});
  });
}
