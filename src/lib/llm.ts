// dsh-trio 共享 LLM 调用助手:通过 ctx.llm 跑一次性文本生成(评审等)。

import type { ModelSelection, TrioContext } from "./types.js";

/** 流式 chunk 的最小形状。 */
interface StreamChunkLite {
  type?: string;
  text?: string;
}

/** ctx.llm 的最小接口。 */
interface LlmService {
  stream: (request: Record<string, unknown>) => AsyncIterable<StreamChunkLite>;
}

/**
 * 用 ctx.llm 跑一次文本生成。模型选择顺序:spec({provider,model}) → agent 默认模型。
 */
export async function runLlm(
  ctx: TrioContext,
  spec: Partial<ModelSelection> | undefined,
  system: string,
  prompt: string,
  signal?: AbortSignal,
  options: { maxTokens?: number } = {},
): Promise<string> {
  const llm = ctx.get<LlmService>("llm");
  if (llm === undefined) throw new Error("llm service unavailable");
  const overrides = spec ?? {};
  let provider = overrides.provider;
  let model = overrides.model;
  if (!provider || !model) {
    try {
      const selection = ctx
        .get<{ currentSelection: () => ModelSelection }>("agentDefaultModel")
        ?.currentSelection();
      provider = provider ?? selection?.provider;
      model = model ?? selection?.model;
    } catch {
      /* keep undefined */
    }
  }
  if (!provider || !model) {
    throw new Error("no review model configured (set trio.*.reviewModel or a default model)");
  }
  const chunks = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens: options.maxTokens ?? 2000,
    signal,
  });
  let text = "";
  for await (const chunk of chunks) {
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
  }
  return text.trim();
}
