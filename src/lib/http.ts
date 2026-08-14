// dsh-trio shared HTTP helpers for webServer route handlers.
// webServer handlers receive plain node:http IncomingMessage/ServerResponse.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Parse the request URL pathname (query strings are ignored). */
export function urlPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    return "/";
  }
}

/** Read the request body as a UTF-8 string (bounded). */
export function readRawBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Read and parse a JSON request body; `undefined` when the body is empty. */
export async function readJsonBody(req: IncomingMessage, limitBytes?: number): Promise<unknown> {
  const raw = await readRawBody(req, limitBytes);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Send a JSON response. */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** Send a plain text response. */
export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** SSE 流写入器。 */
export interface SseWriter {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

/** Start an SSE response stream and return a writer. */
export function openSse(res: ServerResponse, headers: Record<string, string> = {}): SseWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...headers,
  });
  res.write(": connected\n\n");
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      res.write(`: ${text}\n\n`);
    },
    close() {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    },
  };
}
