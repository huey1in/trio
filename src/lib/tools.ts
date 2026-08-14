// dsh-trio shared helpers: workspace cwd resolution and plain tool definitions.

import type { PlainToolDefinition, ToolRunContext } from "./types.js";

/**
 * Resolve the workspace working directory for one tool execution.
 * Prefers the calling agent's session cwd; falls back to the host process cwd.
 */
export function workspaceCwd(exec: ToolRunContext | undefined): string {
  try {
    const cwd = exec?.agent?.session?.meta?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  } catch {
    /* fall through */
  }
  return process.cwd();
}

/** definePlainTool 的输入选项。 */
export interface PlainToolOptions {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execute: (args: any, exec: ToolRunContext) => Promise<unknown> | unknown;
  render?: (args: any, value: any) => string;
  presentCall?: (args: any) => unknown;
  concurrencySafe?: boolean;
  timeoutMs?: number;
}

/**
 * Build a plain ToolDefinition for `ctx.tools.register` without depending on
 * any @deepseek-ai package (max version-alignment tolerance).
 */
export function definePlainTool(options: PlainToolOptions): PlainToolDefinition {
  const render = options.render ?? ((_args: unknown, value: unknown) => JSON.stringify(value, null, 2));
  const definition: PlainToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema ?? {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      render: (args, value) => [{ type: "text", text: render(args, value) }],
    },
    execute: options.execute,
  };
  if (options.presentCall !== undefined) definition.presentCall = options.presentCall;
  if (options.concurrencySafe) definition.isConcurrencySafe = () => true;
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs;
  return definition;
}

/** Generic card view used by most dsh-trio tools. */
export function genericCard(kind: string, title: string, rawInput: string): unknown {
  return { card: "generic", kind, title, rawInput };
}
