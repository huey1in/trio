// dsh-trio · 原生 Web UI 嵌入(/trio/embed.js)
//
// 通过 webServer.tapIndex 把脚本注入 DSH index.html,在原生界面上渲染
// 右下角浮动面板:浏览器/MCP/GitHub 三模块状态 + 浏览器实时画面 +
// GitHub 最近事件看板。全部 fixed 定位、只读官方 CSS 变量(--dsw-alias-*),
// 不依赖官方 DOM 结构,自动适配亮/暗主题。
//
// 历史:0.x 曾提供独立 /trio 控制台页,1.1.0 起与原生嵌入面板功能重叠,
// 1.2.0 起移除页面,事件看板并入面板,只保留嵌入。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "./lib/types.js";
import { sendText } from "./lib/http.js";
import { resolveConfig, type ConfigSchema } from "./lib/config.js";

export const name = "trio-console";
export const inject = ["webServer"];

const CONSOLE_SCHEMA: ConfigSchema = {
  enabled: { type: "boolean", optional: true },
  path: { type: "string" },
};

const DEFAULT_CONFIG = {
  path: "/trio",
};

function embedJs(base: string): string {
  return `(function () {
  "use strict";
  var base = ${JSON.stringify(base)};
  var B = base + "/browser", M = base + "/mcp", G = base + "/github";

  // —— 挂载(等 body 就绪) ——
  var root = null, btn = null, panel = null, open = false, shot = null, eventsBox = null;
  function css() {
    var s = document.createElement("style");
    s.textContent = [
      "#dsh-trio-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:40px;height:40px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 16px var(--dsw-alias-bg-mask-2);transition:background .15s ease}",
      "#dsh-trio-fab:hover{background:var(--dsw-alias-button-floating-hover)}",
      "#dsh-trio-panel{position:fixed;right:16px;bottom:64px;z-index:2147483000;width:320px;max-height:70vh;overflow-y:auto;display:none;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:0 8px 32px var(--dsw-alias-bg-mask-2);padding:12px}",
      "#dsh-trio-panel.open{display:flex}",
      ".trio-head{display:flex;align-items:center;gap:8px}",
      ".trio-title{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
      ".trio-caption{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}",
      ".trio-row{display:flex;align-items:center;gap:8px;padding:6px 0}",
      ".trio-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-dimmed);flex:none}",
      ".trio-dot.ok{background:var(--dsw-alias-state-success-primary)}",
      ".trio-dot.bad{background:var(--dsw-alias-state-error-primary)}",
      ".trio-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".trio-value{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
      ".trio-shot{width:100%;display:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
      ".trio-shot.on{display:block}",
      ".trio-actions{display:flex;gap:8px;padding-top:4px}",
      ".trio-link{flex:1;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}",
      ".trio-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".trio-events{display:none;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}",
      ".trio-events.on{display:block}",
      ".trio-events-title{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;margin-bottom:4px}",
      ".trio-event{display:flex;gap:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".trio-event .ok{color:var(--dsw-alias-state-success-primary);flex:none}",
      ".trio-event .miss{color:var(--dsw-alias-state-error-primary);flex:none}",
    ].join("\\n");
    document.head.appendChild(s);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function probe(url, opts) {
    return fetch(url, Object.assign({ cache: "no-store" }, opts || {}))
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, body: t }; }); })
      .catch(function (e) { return { ok: false, status: 0, body: String(e) }; });
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2);
    return hh + ":" + mm;
  }
  function renderEvents(list) {
    if (eventsBox === null) return;
    eventsBox.innerHTML = "";
    if (!list || list.length === 0) { eventsBox.className = "trio-events"; return; }
    eventsBox.className = "trio-events on";
    eventsBox.appendChild(el("div", "trio-events-title", "GitHub 最近事件"));
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var line = el("div", "trio-event");
      line.appendChild(el("span", e.handled ? "ok" : "miss", e.handled ? "✓" : "·"));
      line.appendChild(document.createTextNode(
        fmtTime(e.ts) + " " + (e.event || "") + "/" + (e.action || "") + " " + (e.repo || "") +
        (e.number ? "#" + e.number : "") + (e.title ? " — " + e.title.slice(0, 40) : "")
      ));
      eventsBox.appendChild(line);
    }
  }
  function mount() {
    if (root !== null) return;
    css();
    btn = el("button", null); btn.id = "dsh-trio-fab"; btn.title = "dsh-trio"; btn.textContent = "🐋";
    panel = el("div", null); panel.id = "dsh-trio-panel";
    panel.appendChild(el("div", "trio-head"));
    var title = el("span", "trio-title", "dsh-trio"); panel.firstChild.appendChild(title);
    // 头部小字直接给出 MCP 端点,方便配置 MCP 客户端。
    panel.firstChild.appendChild(el("span", "trio-caption", location.origin + M));
    function row(id) { var r = el("div", "trio-row"); var d = el("span", "trio-dot"); r.appendChild(d); var l = el("span", "trio-label", id); r.appendChild(l); var v = el("span", "trio-value", "—"); r.appendChild(v); return { row: r, dot: d, value: v }; }
    var rB = row("浏览器"), rM = row("MCP"), rG = row("GitHub");
    shot = el("img", "trio-shot"); shot.alt = "browser";
    eventsBox = el("div", "trio-events");
    var actions = el("div", "trio-actions");
    var aShot = el("a", "trio-link", "实时画面 ↗"); aShot.href = B; aShot.target = "_blank";
    actions.appendChild(aShot);
    panel.appendChild(rB.row); panel.appendChild(rM.row); panel.appendChild(rG.row);
    panel.appendChild(shot); panel.appendChild(eventsBox); panel.appendChild(actions);
    btn.addEventListener("click", function () { open = !open; panel.className = open ? "open" : ""; panel.id = "dsh-trio-panel"; });
    root = document.createElement("div");
    root.appendChild(btn); root.appendChild(panel);
    document.body.appendChild(root);
    function refresh() {
      probe(B + "/status").then(function (b) {
        if (b.ok) { var s = JSON.parse(b.body); rB.dot.className = "trio-dot " + (s.open ? "ok" : "bad"); rB.value.textContent = s.open ? (s.tabs + " 标签 · " + (s.url || "").slice(0, 24)) : "未打开"; }
        else { rB.dot.className = "trio-dot bad"; rB.value.textContent = "未启用"; }
      }).catch(function () {});
      probe(M, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }).then(function (m) {
        if (m.ok && m.body.indexOf("dsh-trio-mcp") !== -1) { rM.dot.className = "trio-dot ok"; rM.value.textContent = "在线"; }
        else { rM.dot.className = "trio-dot bad"; rM.value.textContent = "未启用"; }
      }).catch(function () {});
      // GitHub:webhook 探测决定状态文案,事件看板补充最近事件数与列表。
      var gBase = "未启用";
      probe(G + "/webhook", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "ping" }, body: JSON.stringify({ zen: "x" }) }).then(function (g) {
        if (g.status === 202 || g.status === 200) { rG.dot.className = "trio-dot ok"; gBase = "就绪"; }
        else if (g.status === 401) { rG.dot.className = "trio-dot ok"; gBase = "在线(签名)"; }
        else { rG.dot.className = "trio-dot bad"; }
      }).catch(function () { rG.dot.className = "trio-dot bad"; }).then(function () {
        return probe(G + "/events");
      }).then(function (e) {
        if (e && e.ok) {
          var list = JSON.parse(e.body).events || [];
          renderEvents(list.slice(0, 3));
          rG.value.textContent = gBase + (list.length > 0 ? " · " + list.length + " 事件" : "");
        } else {
          renderEvents([]);
          rG.value.textContent = gBase;
        }
      }).catch(function () { rG.value.textContent = gBase; });
      if (open) {
        probe(B + "/status").then(function (b) {
          if (b.ok) { var s = JSON.parse(b.body); if (s.open) { shot.className = "trio-shot on"; shot.src = B + "/screenshot?v=" + Date.now(); } else { shot.className = "trio-shot"; } }
        }).catch(function () {});
      }
    }
    refresh();
    setInterval(refresh, 5000);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();`;
}

/** 原生 UI 注入:exact 路由提供 embed.js + tapIndex 注入 script 标签。 */
function registerEmbed(
  webServer: { register(route: WebRoute): () => void; tapIndex(transform: (html: string) => string): () => void },
  base: string,
): () => void {
  const embedPath = `${base}/embed.js`;
  const script = embedJs(base);
  const disposeRoute = webServer.register({
    kind: "exact",
    path: embedPath,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if ((req.method ?? "GET") !== "GET") {
        sendText(res, 405, "method not allowed");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(script),
      });
      res.end(script);
    },
  });
  const scriptTag = `<script src="${embedPath}" defer></script>`;
  const disposeTap = webServer.tapIndex((html) => {
    if (html.includes("dsh-trio")) return html; // 已注入
    const idx = html.lastIndexOf("</head>");
    if (idx === -1) return html;
    return `${html.slice(0, idx)}${scriptTag}${html.slice(idx)}`;
  });
  return () => {
    try {
      disposeRoute();
      disposeTap();
    } catch {
      /* ignore */
    }
  };
}

export function apply(ctx: TrioContext, rawConfig: Record<string, any>) {
  const config = resolveConfig("console", CONSOLE_SCHEMA, DEFAULT_CONFIG, rawConfig);
  if (typeof config.enabled === "boolean" && !config.enabled) return;
  const webServer = ctx.get<{ register(route: WebRoute): () => void; tapIndex(transform: (html: string) => string): () => void; port?: number }>("webServer");
  if (webServer === undefined) return;
  const base = config.path.replace(/\/+$/, "");
  const disposeEmbed = registerEmbed(webServer, base);
  ctx.effect(() => () => {
    try {
      disposeEmbed();
    } catch {
      /* ignore */
    }
  });
  const port = webServer.port;
  if (typeof port === "number") {
    ctx.logger?.info?.(`dsh-trio/console: native UI widget injected (${base}/embed.js)`);
  }
}
