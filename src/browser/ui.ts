// dsh-trio · 浏览器 — 实时画面页与路由
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import type { BrowserConfig } from "./types.js";
import { activePage } from "./session.js";
import { statusTool } from "./tools.js";
import { urlPath, sendText, sendJson } from "../lib/http.js";
const LIVE_VIEW_HTML = (api: string) => `<!doctype html>
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
  // 服务端注入的 API 基址(绝对路径):页面在 /trio/browser 无尾斜杠访问时,
  // 相对路径 ./status 会解析到 /trio/status 导致 404。
  const API = ${JSON.stringify(api)};
  async function refresh() {
    try {
      const r = await fetch(API + '/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const s = await r.json();
      if (s.open) {
        dot.className = 'on';
        status.textContent = (s.url || '(空白页)') + ' — ' + (s.title || '');
        shot.style.display = 'block';
        empty.style.display = 'none';
        shot.src = API + '/screenshot?v=' + Date.now();
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


export function registerLiveView(ctx: TrioContext, config: BrowserConfig) {
  const webServer = ctx.get<{ register(route: WebRoute): () => void }>("webServer");
  if (webServer === undefined) return;
  const base = (config.liveViewPath ?? "/trio/browser").replace(/\/+$/, "");
  const disposers: (() => void)[] = [];
  disposers.push(
    webServer.register({
      kind: "prefix",
      path: base,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const path = urlPath(req);
        if (path === base || path === `${base}/`) {
          sendText(res, 200, LIVE_VIEW_HTML(base), { "content-type": "text/html; charset=utf-8" });
          return;
        }
        if (path === `${base}/status`) {
          const state = await statusTool();
          sendJson(res, 200, state);
          return;
        }
        if (path === `${base}/screenshot`) {
          const page = activePage();
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

