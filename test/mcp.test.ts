import { describe, it, expect } from "vitest";
import { MCP_TOOLS, summarize, truncate, projectEvent, rpcError, rpcResult } from "../src/mcp.js";

describe("MCP_TOOLS", () => {
  it("暴露 5 个核心工具", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "dsh_list_sessions",
        "dsh_read_session",
        "dsh_search_sessions",
        "dsh_run_agent",
        "dsh_agents_status",
      ]),
    );
  });

  it("每个工具都有 description 与 inputSchema", () => {
    for (const tool of MCP_TOOLS) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("dsh_run_agent 支持模型覆盖与流式参数", () => {
    const run = MCP_TOOLS.find((t) => t.name === "dsh_run_agent")!;
    const props = (run.inputSchema as any).properties;
    expect(props.provider).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.cwd).toBeDefined();
  });
});

describe("summarize", () => {
  it("提取最新 assistant 文本与结束原因", () => {
    const events = [
      { seq: 0, type: "turn/start" },
      {
        seq: 1,
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } },
      },
      { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } },
    ];
    const out = summarize(events, 0);
    expect(out.text).toBe("hello world");
    expect(out.reason?.kind).toBe("completed");
  });

  it("firstSeq 之前的文本被忽略", () => {
    const events = [
      { seq: 0, type: "turn/start" },
      { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "old" }] } } },
      { seq: 2, type: "turn/start" },
      { seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "new" }] } } },
    ];
    expect(summarize(events, 2).text).toBe("new");
  });

  it("容错缺失字段", () => {
    expect(summarize([{ seq: 0 }] as any, 0).text).toBe("");
  });
});

describe("truncate", () => {
  it("超长截断", () => {
    expect(truncate("abcdef", 3)).toBe("abc\n…(截断)");
  });
  it("短文本原样", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
});

describe("projectEvent", () => {
  it("消息事件投影文本", () => {
    const out = projectEvent({
      seq: 1,
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "hi" }] } },
    });
    expect(out.text).toBe("hi");
  });

  it("工具调用投影 name/args", () => {
    const out = projectEvent({ seq: 2, type: "tool/call", data: { name: "bash", arguments: { c: "ls" } } });
    expect(out.name).toBe("bash");
  });

  it("未知字段容错", () => {
    const out = projectEvent({ seq: 9, type: "weird" } as any);
    expect(out.seq).toBe(9);
  });
});

describe("JSON-RPC 信封", () => {
  it("rpcResult", () => {
    expect(rpcResult(7, { a: 1 })).toEqual({ jsonrpc: "2.0", id: 7, result: { a: 1 } });
  });
  it("rpcError", () => {
    expect(rpcError(null, -32601, "Method not found")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "Method not found" },
    });
  });
});
