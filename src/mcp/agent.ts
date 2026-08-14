// dsh-trio · MCP — agent 执行(dsh_run_agent 与状态)
import { randomUUID } from "node:crypto";
import type { TrioContext } from "../lib/types.js";
import type { McpConfig, ProgressFn, DeltaFn } from "./types.js";
import { summarize, truncate } from "./sessions.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runAgent(ctx: TrioContext, args: Record<string, any>, onProgress: ProgressFn | undefined, onDelta: DeltaFn | undefined) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error("agent services unavailable (need agents/sessions/agentDefaultModel)");
  }
  const prompt = String(args?.prompt ?? "");
  if (!prompt.trim()) throw new Error("prompt is required");
  let selection;
  try {
    selection = defaultModel.currentSelection();
  } catch (error) {
    throw new Error(`no default model configured: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 模型覆盖:provider/model 任一传入即覆盖默认选择
  const agentOptions = {
    provider: String(args?.provider ?? "") || selection.provider,
    model: String(args?.model ?? "") || selection.model,
  };
  const cwd = String(args?.cwd ?? "") || process.cwd();
  const sessionId = `session-${randomUUID()}`;
  onProgress?.(1, 4, "creating agent");
  const handle = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
  });
  try {
    await handle.agent.whenIdle();
    const firstSeq = handle.agent.session.seq;
    onProgress?.(2, 4, "agent running");
    handle.agent.followup({
      content: [{ type: "text", text: prompt }],
      source: { kind: "user" },
    });
    // 等待完成,同时轮询输出增量推送流式文本
    const donePromise = handle.agent.whenIdle();
    let seenSeq = firstSeq;
    let pushedText = "";
    while (true) {
      const events = handle.agent.session.events;
      for (const event of events) {
        if (event.seq <= seenSeq) continue;
        seenSeq = event.seq;
        if (event.type !== "assistant/message") continue;
        const text = (event.data?.message?.content ?? [])
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text ?? "")
          .join("");
        if (text.length > pushedText.length) {
          const delta = text.slice(pushedText.length);
          pushedText = text;
          onDelta?.(delta);
        }
      }
      const raced = await Promise.race([donePromise.then(() => "done"), sleep(500).then(() => "tick")]);
      if (raced === "done") break;
    }
    onProgress?.(3, 4, "collecting result");
    await sessions.flush(handle.agent.session);
    const outcome = summarize(handle.agent.session.events, firstSeq);
    onProgress?.(4, 4, "done");
    return {
      sessionId,
      text: truncate(outcome.text, 120000),
      reasonKind: outcome.reason?.kind ?? null,
      reasonCode: outcome.reason?.error?.code ?? null,
    };
  } finally {
    try {
      await handle.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}


export async function agentsStatus(ctx: TrioContext) {
  const agents = ctx.get("agents");
  if (agents === undefined) throw new Error("agents service unavailable");
  const list = agents.list();
  const agentsOut = [];
  for (const agent of list) {
    let status = "unknown";
    try {
      status = agent.status ?? "unknown";
    } catch {
      /* defensive */
    }
    agentsOut.push({ sessionId: agent.id, status });
  }
  return { agents: agentsOut, count: agentsOut.length };
}

