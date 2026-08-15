// dsh-reef · MCP — 会话查询与事件投影
import type { ReefContext } from "../lib/types.js";
import type { McpConfig } from "./types.js";
export function summarize(events: any[], firstSeq: number) {
  let started = false;
  let text = "";
  let reason = null;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content ?? [])
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text ?? "")
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data?.reason ?? null;
  }
  return { text, reason };
}

export function truncate(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断)` : text;
}

/** 事件 → 一行摘要(防御性投影,任何字段缺失都不抛错)。 */
export function projectEvent(event: Record<string, any>, maxChars = 400) {
  const { seq, type, data } = event;
  const base = { seq, type };
  try {
    if (type === "assistant/message" || type === "user/message") {
      const content = data?.message?.content ?? [];
      const text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text ?? "")
        .join("");
      return { ...base, text: truncate(text, maxChars) };
    }
    if (type === "tool/call") {
      return { ...base, name: data?.name ?? "", args: truncate(JSON.stringify(data?.arguments ?? {}), maxChars) };
    }
    if (type === "tool/result") {
      return { ...base, error: data?.isError === true };
    }
    if (type === "turn/end") {
      return { ...base, reason: data?.reason?.kind ?? null };
    }
    return base;
  } catch {
    return base;
  }
}

export async function listSessions(ctx: ReefContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const limit = Math.min(Math.max(Number(args?.limit ?? 50) || 50, 1), 200);
  const records = await query.listSessions();
  const rows = [];
  for (const record of records.slice(-limit).reverse()) {
    let title;
    try {
      const t = await query.readTitle(record.header.id);
      title = t?.title ?? "";
    } catch {
      title = "";
    }
    rows.push({
      sessionId: record.header.id,
      title,
      cwd: record.header.cwd ?? "",
      createdAt: record.header.createdAt ?? 0,
      live: record.live === true,
      persisted: record.persisted === true,
    });
  }
  return { sessions: rows };
}

export async function readSession(ctx: ReefContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const sessionId = String(args?.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");
  const maxEvents = Math.min(Math.max(Number(args?.maxEvents ?? 200) || 200, 1), 2000);
  const snapshot = await query.readSession(sessionId);
  const events = (snapshot.events ?? []).slice(-maxEvents).map((event: any) => projectEvent(event));
  return {
    sessionId,
    cwd: snapshot.session?.cwd ?? "",
    createdAt: snapshot.session?.createdAt ?? 0,
    events,
  };
}

export async function searchSessions(ctx: ReefContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const q = String(args?.query ?? "");
  if (!q) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 100);
  const page = await query.searchSessions({ query: q, limit });
  const hits = (page.hits ?? []).map((hit: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const key of ["sessionId", "title", "snippet", "score"]) {
      if (hit[key] !== undefined) out[key] = hit[key];
    }
    return out;
  });
  return { query: q, hits };
}


export async function resourcesList(ctx: ReefContext, args: Record<string, any>) {
  const query = ctx.get("sessionQuery");
  if (query === undefined) return { resources: [] };
  const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 50);
  const records = await query.listSessions();
  const resources = [];
  for (const record of records.slice(-limit).reverse()) {
    let title = "";
    try {
      const t = await query.readTitle(record.header.id);
      title = t?.title ?? "";
    } catch {
      /* defensive */
    }
    resources.push({
      uri: `dsh://sessions/${record.header.id}`,
      name: `${record.header.id}${title ? ` — ${title}` : ""}`,
      description: `DSH 会话${record.header.cwd ? ` (cwd: ${record.header.cwd})` : ""}`,
      mimeType: "application/json",
    });
  }
  return { resources };
}

export async function resourcesRead(ctx: ReefContext, args: Record<string, any>) {
  const uri = String(args?.uri ?? "");
  const match = uri.match(/^dsh:\/\/sessions\/(.+)$/);
  if (!match) throw new Error(`unsupported resource uri: ${uri}`);
  const sessionId = match[1];
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("sessionQuery service unavailable");
  const snapshot = await query.readSession(sessionId);
  const events = (snapshot.events ?? []).slice(-500).map((event: any) => projectEvent(event, 2000));
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            sessionId,
            cwd: snapshot.session?.cwd ?? "",
            createdAt: snapshot.session?.createdAt ?? 0,
            events,
          },
          null,
          2,
        ),
      },
    ],
  };
}

