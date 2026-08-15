// dsh-trio · 控制台(/trio)
//
// 一个汇总三个模块状态的迷你控制台页。零模块耦合:页面 JS 通过同源 fetch
// 探测各模块端点是否存在/可用。样式呼应 banner 的 anthropic.com 人文简朴风。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "./lib/types.js";
import { urlPath, sendText } from "./lib/http.js";
import { resolveConfig, type ConfigSchema } from "./lib/config.js";

export const name = "trio-console";
export const inject = ["webServer"];

const CONSOLE_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  path: { type: "string" },
  mcpPath: { type: "string" },
  browserPath: { type: "string" },
  githubWebhookPath: { type: "string" },
};

const DEFAULT_CONFIG = {
  path: "/trio",
  mcpPath: "/trio/mcp",
  browserPath: "/trio/browser",
  githubWebhookPath: "/trio/github/webhook",
};

const CONSOLE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-trio · 控制台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5efe2; color: #2b2723; font-family: Georgia, 'Times New Roman', serif; }
  header { padding: 28px 32px 12px; border-bottom: 2px solid #2b2723; display: flex; align-items: baseline; gap: 16px; }
  header h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: 1px; }
  header .sub { font-size: 13px; color: #8a6d3b; font-style: italic; }
  main { padding: 24px 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
  .card { background: #faf6ec; border: 1.5px solid #2b2723; border-radius: 10px; padding: 18px 20px; box-shadow: 3px 3px 0 rgba(43,39,35,.12); }
  .card h2 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  .card .desc { margin: 0 0 12px; font-size: 12.5px; color: #6b5f52; }
  .row { font-size: 13px; margin: 6px 0; display: flex; justify-content: space-between; gap: 12px; }
  .row .k { color: #8a6d3b; }
  .row .v { font-family: ui-monospace, monospace; font-size: 12.5px; word-break: break-all; text-align: right; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #c9c2b4; margin-right: 8px; }
  .dot.ok { background: #2e7d32; }
  .dot.bad { background: #c62828; }
  .btn { display: inline-block; margin-top: 10px; padding: 6px 14px; border: 1.5px solid #2b2723; border-radius: 999px; background: #f5efe2; color: #2b2723; font-family: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
  .btn:hover { background: #2b2723; color: #f5efe2; }
  .tools { font-size: 12px; color: #6b5f52; margin-top: 8px; line-height: 1.7; }
  footer { padding: 12px 32px 28px; font-size: 12px; color: #8a6d3b; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>🐋 dsh-trio</h1>
  <span class="sub">browser · mcp · github — one install, three superpowers</span>
</header>
<main>
  <section class="card">
    <h2><span class="dot" id="b-dot"></span>🧭 浏览器自动化</h2>
    <p class="desc">Playwright 共享浏览器 · 多标签 · 下载 · Cookie</p>
    <div class="row"><span class="k">状态</span><span class="v" id="b-status">探测中…</span></div>
    <div class="row"><span class="k">标签页</span><span class="v" id="b-tabs">-</span></div>
    <div class="row"><span class="k">当前页面</span><span class="v" id="b-url">-</span></div>
    <a class="btn" id="b-link" href="javascript:void(0)" target="_blank" onclick="this.href = location.pathname.replace(/\/+$/, '') + '/browser'; return true;">打开实时画面 ↗</a>
  </section>

  <section class="card">
    <h2><span class="dot" id="m-dot"></span>🔌 MCP Server</h2>
    <p class="desc">Streamable HTTP · 把 DSH 暴露给任何 MCP 客户端</p>
    <div class="row"><span class="k">端点</span><span class="v" id="m-url">-</span></div>
    <div class="row"><span class="k">协议</span><span class="v" id="m-ver">-</span></div>
    <div class="row"><span class="k">工具</span><span class="v" id="m-tools">-</span></div>
    <button class="btn" id="m-test">测试连接</button>
  </section>

  <section class="card">
    <h2><span class="dot" id="g-dot"></span>🐙 GitHub 集成</h2>
    <p class="desc">issue / PR 工具 · webhook 自动评审 · issue 自动修复</p>
    <div class="row"><span class="k">Webhook</span><span class="v" id="g-url">-</span></div>
    <div class="row"><span class="k">端点状态</span><span class="v" id="g-status">探测中…</span></div>
    <div class="tools" id="g-hint">配置:仓库 Settings → Webhooks 指向此 URL,事件勾选 Pull requests 与 Issues,并设置 GITHUB_TOKEN 与 webhook secret。</div>
    <div class="tools" id="g-events" style="display:none"></div>
  </section>
</main>
<footer>dsh-trio · DeepSeek Harness 全家桶 — 控制台仅显示状态,不承载业务数据。</footer>
<script>
  const $ = (id) => document.getElementById(id);
  // 当前控制台挂载路径(去掉尾斜杠);相对路径在无尾斜杠的 URL 下会解析错位
  const base = location.pathname.replace(/\/+$/, '');
  const bUrl = base + '/browser/status';
  const mUrl = base + '/mcp';
  const gUrl = base + '/github/webhook';
  const geUrl = base + '/github/events';
  async function probe(url, opts) {
    try {
      const r = await fetch(url, { cache: 'no-store', ...opts });
      return { ok: r.ok, status: r.status, body: await r.text().catch(() => '') };
    } catch (e) { return { ok: false, status: 0, body: String(e) }; }
  }
  async function refresh() {
    // 浏览器
    const b = await probe(bUrl);
    if (b.ok) {
      try {
        const s = JSON.parse(b.body);
        $('b-dot').className = 'dot ' + (s.open ? 'ok' : 'bad');
        $('b-status').textContent = s.open ? '已打开' : '未打开';
        $('b-tabs').textContent = s.tabs ?? '-';
        $('b-url').textContent = (s.url || '(空白页)').slice(0, 60);
      } catch { $('b-status').textContent = '响应异常'; }
    } else {
      $('b-dot').className = 'dot bad';
      $('b-status').textContent = '模块未启用';
      $('b-link').style.display = 'none';
    }
    // MCP
    const m = await probe(mUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    if (m.ok && m.body.includes('dsh-trio-mcp')) {
      $('m-dot').className = 'dot ok';
      try {
        const msg = JSON.parse(m.body);
        const r = msg.result || msg.error;
        $('m-ver').textContent = r?.protocolVersion ?? 'ok';
      } catch { $('m-ver').textContent = 'ok'; }
      const tl = await probe(mUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
      if (tl.ok) {
        try { const n = JSON.parse(tl.body).result?.tools?.length ?? 0; $('m-tools').textContent = n + ' 个工具'; } catch {}
      }
    } else {
      $('m-dot').className = 'dot bad';
      $('m-ver').textContent = '模块未启用';
      $('m-tools').textContent = '-';
      $('m-test').style.display = 'none';
    }
    // GitHub
    const g = await probe(gUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' }, body: JSON.stringify({ zen: 'console-probe' }) });
    if (g.status === 202 || g.status === 200) {
      $('g-dot').className = 'dot ok';
      $('g-status').textContent = '就绪 (HTTP ' + g.status + ')';
    } else if (g.status === 401) {
      $('g-dot').className = 'dot ok';
      $('g-status').textContent = '在线 (签名校验 401,正常)';
    } else if (g.status === 405) {
      $('g-dot').className = 'dot bad';
      $('g-status').textContent = '模块未启用';
    } else {
      $('g-dot').className = 'dot bad';
      $('g-status').textContent = '无响应 (' + g.status + ')';
    }
    // GitHub 事件看板
    const ge = await probe(geUrl);
    if (ge.ok) {
      try {
        const list = JSON.parse(ge.body).events || [];
        const box = $('g-events');
        if (list.length > 0) {
          box.style.display = 'block';
          box.innerHTML = '<strong>最近事件(' + list.length + '):</strong><br>' + list.slice(0, 8).map((e) => {
            const t = new Date(e.ts);
            const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
            return hh + ' ' + (e.handled ? '✓' : '·') + ' ' + e.event + '/' + e.action + ' ' + (e.repo || '') + (e.number ? '#' + e.number : '') + (e.title ? ' — ' + e.title.slice(0, 30) : '');
          }).join('<br>');
        } else {
          box.style.display = 'none';
        }
      } catch {}
    }
  }
  $('m-test').addEventListener('click', async () => {
    const m = await probe(mUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'initialize', params: {} }) });
    $('m-ver').textContent = m.ok ? '连接成功 ✓' : '连接失败';
  });
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("console", CONSOLE_SCHEMA, DEFAULT_CONFIG, rawConfig);
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const base = config.path.replace(/\/+$/, "");
  const dispose = webServer.register({
    kind: "prefix",
    path: base,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const path = urlPath(req);
      if (path === base || path === `${base}/` || path === `${base}/console`) {
        sendText(res, 200, CONSOLE_HTML, { "content-type": "text/html; charset=utf-8" });
        return;
      }
      sendText(res, 404, "not found");
    },
  });
  ctx.effect(() => () => {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  });
  const port = webServer.port;
  if (typeof port === "number") {
    ctx.logger?.info?.(`dsh-trio/console: control panel at http://127.0.0.1:${port}${base}`);
  }
}
