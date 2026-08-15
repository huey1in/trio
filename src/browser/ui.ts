// dsh-trio · 浏览器 — 实时画面数据 API(/status /screenshot /history /settings)
//
// 供原生嵌入面板与实时画面模态框轮询的同源数据端点。1.3.0 起不再提供
// 独立 HTML 页面:人在原生界面右下角面板点缩略图即可弹出大屏模态框,
// 内含实时画面与访问历史。/settings 是面板 ⚙ 设置区的浏览器配置后端。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrioContext, WebRoute } from "../lib/types.js";
import type { BrowserConfig } from "./types.js";
import { activePage, historyOf, currentProfile } from "./session.js";
import { statusTool } from "./tools.js";
import { urlPath, sendText, sendJson } from "../lib/http.js";
import { handleModuleSettings } from "../lib/settings.js";
import { BROWSER_SETTING_FIELDS } from "./settings.js";

export function registerBrowserApi(ctx: TrioContext, config: BrowserConfig) {
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
        if (path === `${base}/settings`) {
          await handleModuleSettings(ctx, req, res, "browser", BROWSER_SETTING_FIELDS);
          return;
        }
        if (path === `${base}/status`) {
          const state = await statusTool();
          sendJson(res, 200, state);
          return;
        }
        if (path === `${base}/history`) {
          // 访问历史:按时间倒序,最新在前。
          sendJson(res, 200, {
            profile: currentProfile,
            history: [...historyOf(currentProfile)].reverse(),
          });
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
