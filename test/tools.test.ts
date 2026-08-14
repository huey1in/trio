import { describe, it, expect } from "vitest";
import { definePlainTool, workspaceCwd, genericCard } from "../src/lib/tools.js";

describe("definePlainTool", () => {
  it("生成完整 ToolDefinition 形状", () => {
    const tool = definePlainTool({
      name: "demo_tool",
      description: "demo",
      parameters: { type: "object", properties: { a: { type: "string" } } },
      execute: async () => ({ ok: true }),
    });
    expect(tool.name).toBe("demo_tool");
    expect(tool.description).toBe("demo");
    expect(tool.parameters.type).toBe("object");
    expect(tool.output.schema.type).toBe("object");
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.output.render).toBe("function");
  });

  it("默认 render 输出 JSON 文本块", () => {
    const tool = definePlainTool({
      name: "t",
      description: "d",
      parameters: {},
      execute: async () => ({ a: 1 }),
    });
    const blocks = tool.output.render({}, { a: 1 });
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain('"a": 1');
  });

  it("自定义 render 生效", () => {
    const tool = definePlainTool({
      name: "t",
      description: "d",
      parameters: {},
      render: (_args, value) => `got ${(value as any).x}`,
      execute: async () => ({ x: 5 }),
    });
    expect(tool.output.render({}, { x: 5 })[0].text).toBe("got 5");
  });

  it("concurrencySafe/timeoutMs/presentCall 可选字段", () => {
    const tool = definePlainTool({
      name: "t",
      description: "d",
      parameters: {},
      concurrencySafe: true,
      timeoutMs: 5000,
      presentCall: (args) => genericCard("x", String(args.a), "y"),
      execute: async () => ({}),
    });
    expect(tool.isConcurrencySafe?.()).toBe(true);
    expect(tool.timeoutMs).toBe(5000);
    expect(tool.presentCall).toBeDefined();
  });
});

describe("workspaceCwd", () => {
  it("优先取 agent session cwd", () => {
    expect(
      workspaceCwd({ agent: { session: { meta: { cwd: "/work" } } } } as any),
    ).toBe("/work");
  });

  it("缺失时回退 process.cwd()", () => {
    expect(workspaceCwd(undefined)).toBe(process.cwd());
    expect(workspaceCwd({} as any)).toBe(process.cwd());
  });
});
