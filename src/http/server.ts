// HTTP plumbing: body reading with a size cap, JSON replies, and the
// per-request id header. Handlers never touch the raw socket; they return a
// response object (or throw an HttpError) and the dispatcher sends it.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The largest request body accepted (10 MiB); larger bodies answer 413. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error a handler throws to answer a status + JSON message body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function unauthorized(message = 'Bad credentials'): HttpError {
  return new HttpError(401, message);
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}

export function methodNotAllowed(message: string): HttpError {
  return new HttpError(405, message);
}

/** Read the whole request body, capped at MAX_BODY_BYTES (413 past the cap). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

/** Parse a JSON body; a malformed body is a 400 with a message (never a crash). */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

/** True when the value is a plain JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface Reply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A JSON reply; `body` is serialized with a trailing newline. */
export function jsonReply(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers };
}

/** A JSON error reply: `{"message": string}`. */
export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** An empty-body reply (204). */
export function emptyReply(status: number, headers: Readonly<Record<string, string>> = {}): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.alloc(0), headers };
}

/** Send a reply, always with a non-empty X-GitHub-Request-Id header. */
export function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = {
    'content-type': reply.contentType,
    'content-length': String(reply.body.length),
    'x-github-request-id': requestId,
    ...(reply.headers ?? {}),
  };
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}
