// dsh-trio · MCP — tools/call 分发
import type { TrioContext } from "../lib/types.js";
import type { McpConfig, ProgressFn, DeltaFn } from "./types.js";
import { listSessions, readSession, searchSessions, resourcesList, resourcesRead } from "./sessions.js";
import { runAgent, agentsStatus } from "./agent.js";
export async function callMcpTool(ctx: TrioContext, name: string, args: Record<string, any>, onProgress: ProgressFn | undefined, onDelta: DeltaFn | undefined) {
  switch (name) {
    case "dsh_list_sessions":
      return listSessions(ctx, args);
    case "dsh_read_session":
      return readSession(ctx, args);
    case "dsh_search_sessions":
      return searchSessions(ctx, args);
    case "dsh_run_agent":
      return runAgent(ctx, args, onProgress, onDelta);
    case "dsh_agents_status":
      return agentsStatus(ctx);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 client_credentials(轻量实现)
// ---------------------------------------------------------------------------

