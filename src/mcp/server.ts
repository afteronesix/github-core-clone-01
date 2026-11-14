// MCP over Streamable HTTP: JSON-RPC 2.0 at POST /mcp, plain JSON answers
// (no SSE — the client accepts either). Both protocol eras:
//
//   modern 2026-07-28: `server/discover` returns identity, capabilities and
//           supportedVersions; no handshake, no session. The client's _meta
//           revision and the Mcp-Protocol-Version header are IGNORED — this
//           server never answers HeaderMismatch (-32020).
//   legacy 2025-11-25 and earlier: `initialize` echoes one of the four
//           handshake revisions; `notifications/initialized` is a 202.
//           No Mcp-Session-Id is ever issued, so DELETE /mcp is a bare 204.
//
// Error contract: unknown method → -32601; unknown tool or missing/invalid
// tool arguments → -32602; malformed request object → -32600; a body that is
// not JSON → HTTP 400 with JSON-RPC -32700 (id null — the body could not be
// parsed, so no id can be echoed). Notifications (no `id`) → HTTP 202, empty
// body. JSON-RPC errors otherwise ride HTTP 200, never 500.

import type { ForgeStore } from '../store/store.ts';
import { emptyReply, jsonReply, type Reply } from '../http/server.ts';
import { MCP_TOOLS, callMcpTool, McpInvalidParams, mcpToolNamed } from './tools.ts';

/** The server's identity, in both the top level and the _meta key the client reads first. */
export const MCP_SERVER_INFO = Object.freeze({ name: 'ghforge', version: '1.0.0' });

/** The revisions this server speaks (modern first — the client prefers it). */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28']);

/** The handshake-era revisions `initialize` accepts (echoed back as offered). */
const LEGACY_REVISIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function successResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResult(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The params object of a request ({} when absent or not an object). */
function paramsOf(request: JsonRpcRequest): Record<string, unknown> {
  return isRecord(request.params) ? request.params : {};
}

/** Handle one JSON-RPC request object. Returns null for a notification (no response). */
function handleRequest(store: ForgeStore, request: JsonRpcRequest): Record<string, unknown> | null {
  const hasId = request.id !== undefined;
  const id: JsonRpcId = hasId ? (request.id as JsonRpcId) : null;
  const method = request.method;

  if (typeof method !== 'string' || method === '') {
    // A malformed request still answers when it carries an id.
    return hasId ? errorResult(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: method must be a non-empty string') : null;
  }

  const isNotification = !hasId;

  switch (method) {
    case 'server/discover': {
      if (isNotification) return null;
      return successResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
    }
    case 'initialize': {
      if (isNotification) return null;
      const params = paramsOf(request);
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const accepted = [...LEGACY_REVISIONS, ...SUPPORTED_VERSIONS];
      if (!accepted.includes(offered)) {
        return errorResult(id, JSON_RPC_INVALID_PARAMS, `Unsupported protocol version: ${offered || '(none)'}`);
      }
      return successResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
    case 'notifications/roots/list_changed': {
      // Notifications never answer.
      return null;
    }
    case 'ping': {
      if (isNotification) return null;
      return successResult(id, {});
    }
    case 'tools/list': {
      if (isNotification) return null;
      // One page, no cursor: the frozen tools array serializes identically
      // on every call (the idempotence check compares bytes).
      return successResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      if (isNotification) return null;
      const params = paramsOf(request);
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '' || mcpToolNamed(name) === undefined) {
        return errorResult(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name || '(none)'}`);
      }
      try {
        const result = callMcpTool(store, name, args);
        return successResult(id, result);
      } catch (err) {
        if (err instanceof McpInvalidParams) {
          return errorResult(id, JSON_RPC_INVALID_PARAMS, err.message);
        }
        // A tool throw is a tool execution error, never an HTTP 500.
        return successResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          structuredContent: { error: err instanceof Error ? err.message : String(err) },
          isError: true,
        });
      }
    }
    default: {
      if (isNotification) return null;
      return errorResult(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

/**
 * POST /mcp — one JSON-RPC request object, or a batch array (each element
 * answered in order; notifications produce no entry). A body that is not JSON
 * answers HTTP 400 with JSON-RPC -32700.
 */
export function handleMcp(store: ForgeStore, rawBody: Buffer): Reply {
  let parsed: unknown;
  try {
    const text = rawBody.toString('utf8');
    parsed = text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return jsonReply(400, errorResult(null, JSON_RPC_PARSE_ERROR, 'Parse error: the request body is not valid JSON'));
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonReply(200, errorResult(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: an empty batch is not allowed'));
    }
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        responses.push(errorResult(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: a batch entry must be an object'));
        continue;
      }
      const response = handleRequest(store, entry as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    // A batch of only notifications answers 202 with no body.
    if (responses.length === 0) return emptyReply(202);
    return jsonReply(200, responses);
  }

  if (!isRecord(parsed)) {
    return jsonReply(200, errorResult(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: the body must be a JSON-RPC object'));
  }
  const response = handleRequest(store, parsed as JsonRpcRequest);
  if (response === null) return emptyReply(202);
  return jsonReply(200, response);
}

/** DELETE /mcp — session termination. No session is ever issued; ignore it. */
export function handleMcpDelete(): Reply {
  return emptyReply(204);
}
