// dsh-reef · MCP — 暴露给客户端的工具表
export const MCP_TOOLS = [
  {
    name: "dsh_list_sessions",
    description: "列出这台机器上 DeepSeek Harness 的会话(含标题、工作目录、创建时间)。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回多少条,默认 50。" },
      },
    },
  },
  {
    name: "dsh_read_session",
    description: "读取一个 DSH 会话的事件摘要(消息、工具调用、完成原因)。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 id(形如 session-xxx)。" },
        maxEvents: { type: "integer", description: "最多返回多少条事件,默认 200,取最新。" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "dsh_search_sessions",
    description: "全文搜索 DSH 会话(标题/内容)。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "dsh_run_agent",
    description:
      "用 DSH 的默认模型启动一个一次性 agent 执行任务(prompt),等待其完成并返回最终文本。适合深度研究、代码审查、多步骤任务。耗时可能较长;若请求带 _meta.progressToken,会通过 notifications/progress 推送进度。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "交给 agent 的任务描述。" },
        cwd: { type: "string", description: "工作目录(默认 DSH 进程目录)。" },
        provider: { type: "string", description: "覆盖默认模型的 provider(可选)。" },
        model: { type: "string", description: "覆盖默认模型的 model id(可选,与 provider 一起传)。" },
        timeoutMs: { type: "integer", description: "超时毫秒,默认 300000。" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "dsh_agents_status",
    description: "列出当前运行中的 DSH agent(会话 id 与状态)。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** 汇总一次 agent 运行:提取最新 assistant 文本与结束原因(参照官方 headless 驱动)。 */
