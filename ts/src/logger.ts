// Structured JSON logger + HTTP middleware with request-id correlation.
// Mirrors go/internal/logger.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const HEADER_REQUEST_ID = "x-request-id";

export type LogLevel = "info" | "warn" | "error";

type Fields = Record<string, unknown>;

export class Logger {
  constructor(
    private service: string,
    private out: NodeJS.WritableStream = process.stdout,
  ) {}

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    const rec = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg,
      ...(fields ?? {}),
    };
    this.out.write(JSON.stringify(rec) + "\n");
  }

  info(msg: string, fields?: Fields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write("error", msg, fields);
  }
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

/** Wraps a handler to emit one access-log line per request and attach a request ID. */
export type ObserveFn = (
  method: string,
  path: string,
  status: number,
  bytes: number,
  durationMs: number,
) => void;

/** Status + bytes accounting that doesn't get in the way of normal res.end. */
class TrackedResponse {
  status = 0;
  bytes = 0;
  constructor(private res: ServerResponse) {
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((code: number, ...rest: unknown[]) => {
      this.status = code;
      return (origWriteHead as (...a: unknown[]) => ServerResponse)(code, ...rest);
    }) as ServerResponse["writeHead"];

    const origWrite = res.write.bind(res);
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") this.bytes += Buffer.byteLength(chunk);
      else if (chunk instanceof Buffer) this.bytes += chunk.length;
      else if (chunk instanceof Uint8Array) this.bytes += chunk.byteLength;
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as ServerResponse["write"];

    const origEnd = res.end.bind(res);
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk) {
        if (typeof chunk === "string") this.bytes += Buffer.byteLength(chunk);
        else if (chunk instanceof Buffer) this.bytes += chunk.length;
        else if (chunk instanceof Uint8Array) this.bytes += chunk.byteLength;
      }
      return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, ...rest);
    }) as ServerResponse["end"];
  }
}

/**
 * Wraps a handler with structured access logging + request-id propagation.
 * Returns a new handler. The original handler's logic is preserved.
 */
export function withHttpLogging(
  logger: Logger,
  observe: ObserveFn | null,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const incoming = req.headers[HEADER_REQUEST_ID];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming) || newId();
    res.setHeader("x-request-id", id);
    (req as IncomingMessage & { requestId?: string }).requestId = id;

    const tracked = new TrackedResponse(res);
    const start = process.hrtime.bigint();
    try {
      await handler(req, res);
    } finally {
      const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const status = tracked.status || 200;
      logger.info("http", {
        request_id: id,
        method: req.method,
        path: req.url,
        status,
        bytes: tracked.bytes,
        duration_ms: durMs,
        remote: req.socket.remoteAddress,
      });
      observe?.(req.method ?? "", req.url ?? "", status, tracked.bytes, durMs);
    }
  };
}

export function requestIdOf(req: IncomingMessage): string {
  return (req as IncomingMessage & { requestId?: string }).requestId ?? "";
}
