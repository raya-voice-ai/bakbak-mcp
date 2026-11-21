/** Small helpers for `node:http` requests and responses. */

import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** Reads a request body as UTF-8, refusing more than `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The media type of a request, lower case, without parameters. */
export function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Parses an `application/x-www-form-urlencoded` or JSON body into string fields; repeated fields are refused. */
export function parseFields(body: string, type: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  if (type === 'application/json') {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') fields.set(k, v);
      else if (typeof v === 'number' || typeof v === 'boolean') fields.set(k, String(v));
    }
    return fields;
  }
  for (const [k, v] of new URLSearchParams(body)) {
    if (fields.has(k)) return undefined;
    fields.set(k, v);
  }
  return fields;
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Cookie value by name. */
export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(html);
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}
