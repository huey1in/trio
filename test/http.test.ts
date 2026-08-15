import { describe, it, expect } from "vitest";
import { urlPath, sendJson, sendText } from "../src/lib/http.js";

/** 最小 ServerResponse mock。 */
function mockRes() {
  const state: { status?: number; headers: Record<string, string>; body: string } = {
    headers: {},
    body: "",
  };
  return {
    state,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = headers;
    },
    end(body?: string) {
      state.body = String(body ?? "");
    },
  };
}

describe("http helpers", () => {
  it("urlPath 解析 pathname 并忽略 query", () => {
    expect(urlPath({ url: "/reef/mcp?x=1" } as any)).toBe("/reef/mcp");
    expect(urlPath({ url: "/" } as any)).toBe("/");
    expect(urlPath({} as any)).toBe("/");
  });

  it("sendJson 写入 JSON + content-type + length", () => {
    const res: any = mockRes();
    sendJson(res, 200, { ok: true });
    expect(res.state.status).toBe(200);
    expect(res.state.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.state.body)).toEqual({ ok: true });
  });

  it("sendJson 支持额外 header", () => {
    const res: any = mockRes();
    sendJson(res, 401, { error: "x" }, { "www-authenticate": 'Bearer realm="t"' });
    expect(res.state.headers["www-authenticate"]).toContain("Bearer");
  });

  it("sendText 写入纯文本", () => {
    const res: any = mockRes();
    sendText(res, 404, "not found");
    expect(res.state.status).toBe(404);
    expect(res.state.body).toBe("not found");
  });
});
