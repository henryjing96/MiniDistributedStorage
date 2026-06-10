// Bearer-token authentication. Mirrors go/internal/auth.

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

export const HEADER_NAME = "authorization";
export const HEADER_PREFIX = "Bearer ";

export interface LoadOptions {
  file?: string;
  inline?: string;
  envName?: string;
}

/** Load a token from --token-file > --token > env. Returns "" if none. */
export async function loadToken(opts: LoadOptions): Promise<string> {
  if (opts.file) {
    const raw = await readFile(opts.file, "utf8");
    return raw.trim();
  }
  if (opts.inline) return opts.inline;
  if (opts.envName) {
    const v = process.env[opts.envName];
    if (v) return v;
  }
  return "";
}

/**
 * Returns an HTTP middleware-style guard. If `token` is empty, auth is
 * disabled (passthrough). Otherwise it requires `Authorization: Bearer <token>`
 * on every path except those in openPaths.
 *
 * Returns `true` if the request was allowed (caller should continue), or
 * `false` if the middleware already wrote a 401 response.
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  openPaths: ReadonlySet<string>,
): boolean {
  if (token === "") return true;
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (openPaths.has(path)) return true;
  const h = req.headers[HEADER_NAME];
  const header = Array.isArray(h) ? h[0] ?? "" : h ?? "";
  if (!header.startsWith(HEADER_PREFIX)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.writeHead(401);
    res.end("missing bearer token");
    return false;
  }
  const got = Buffer.from(header.slice(HEADER_PREFIX.length));
  const expected = Buffer.from(token);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    res.writeHead(401);
    res.end("invalid token");
    return false;
  }
  return true;
}

/** Build an Authorization header value, or undefined if token is empty. */
export function bearerHeader(token: string): string | undefined {
  return token ? HEADER_PREFIX + token : undefined;
}
