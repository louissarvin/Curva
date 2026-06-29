/**
 * F14 MCP server core — JSON-RPC 2.0 dispatcher + tool/resource registries.
 *
 * Hand-rolled per ADR-011 open question #3 fallback: the official
 * `@modelcontextprotocol/sdk` v1.29 targets Node-HTTP / Express-middleware
 * transports. Wiring it through Fastify's reply.hijack() adds dependency and
 * SDK-drift coupling for a small surface (initialize + tools/list + tools/call
 * + resources/list + resources/read + ping). Hand-rolled keeps us on the same
 * tooling as the rest of the backend.
 *
 * JSON-RPC 2.0 spec: https://www.jsonrpc.org/specification
 * MCP tools spec:    https://modelcontextprotocol.io/docs/concepts/tools
 * MCP resources spec: https://modelcontextprotocol.io/docs/concepts/resources
 *
 * Error codes:
 *   -32700  Parse error
 *   -32600  Invalid Request
 *   -32601  Method not found
 *   -32602  Invalid params
 *   -32603  Internal error
 *   -32000  Server-defined error (rate limit)
 */

import { SERVICE_VERSION } from '../../config/main-config.ts';
import type { Lang } from '../i18n/index.ts';

// -----------------------------------------------------------------------------
// Protocol constants
// -----------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = 'curva-companion-mcp';

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RATE_LIMITED: -32000,
} as const;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface McpContext {
  lang: Lang;
  ip: string;
  clientId?: string;
}

export interface McpToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'resource_link'; uri: string; name?: string; description?: string }
  >;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema — passed through verbatim to `tools/list`. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult>;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  /** Text payload for text/* resources. */
  text?: string;
  /** Base64 payload for binary resources (unused for now). */
  blob?: string;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read(ctx: McpContext): Promise<McpResourceContent>;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// -----------------------------------------------------------------------------
// Registries — module singletons.
//
// Registration is idempotent per name/URI so hot-reload during tests does not
// double-register. Access is O(1) via Map.
// -----------------------------------------------------------------------------

const TOOLS = new Map<string, McpTool>();
const RESOURCES = new Map<string, McpResource>();

export const registerTool = (tool: McpTool): void => {
  if (!tool.name || typeof tool.name !== 'string') {
    throw new Error('registerTool: tool.name required');
  }
  TOOLS.set(tool.name, tool);
};

export const registerResource = (res: McpResource): void => {
  if (!res.uri || typeof res.uri !== 'string') {
    throw new Error('registerResource: res.uri required');
  }
  RESOURCES.set(res.uri, res);
};

export const getTools = (): McpTool[] => Array.from(TOOLS.values());
export const getResources = (): McpResource[] => Array.from(RESOURCES.values());
export const getToolCount = (): number => TOOLS.size;
export const getResourceCount = (): number => RESOURCES.size;

/**
 * Test-only: drop all registered tools + resources.
 */
export const __resetRegistryForTest = (): void => {
  TOOLS.clear();
  RESOURCES.clear();
};

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

const buildError = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const buildResult = (
  id: string | number | null,
  result: unknown
): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Public tool descriptor emitted by `tools/list`. Keeps `handler` out.
 */
const publicTool = (t: McpTool) => ({
  name: t.name,
  ...(t.title !== undefined ? { title: t.title } : {}),
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
});

const publicResource = (r: McpResource) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
});

export const handleRpc = async (
  request: JsonRpcRequest,
  ctx: McpContext
): Promise<JsonRpcResponse> => {
  // Validate envelope. `id` may be null for notifications but we always respond;
  // per MCP the server response is required for every request-shape message.
  if (!request || typeof request !== 'object') {
    return buildError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
  }
  if (request.jsonrpc !== '2.0') {
    return buildError(
      request.id ?? null,
      JSON_RPC_ERRORS.INVALID_REQUEST,
      'jsonrpc must be "2.0"'
    );
  }
  const id = request.id ?? null;
  if (typeof request.method !== 'string' || !request.method) {
    return buildError(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'method required');
  }

  switch (request.method) {
    case 'initialize': {
      return buildResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: SERVICE_VERSION,
        },
        instructions:
          'Curva Companion exposes read-only tools over MCP. Call tools/list to see the available surface. All addresses in responses are redacted (short form).',
      });
    }

    case 'ping': {
      return buildResult(id, {});
    }

    case 'tools/list': {
      return buildResult(id, {
        tools: getTools().map(publicTool),
      });
    }

    case 'resources/list': {
      return buildResult(id, {
        resources: getResources().map(publicResource),
      });
    }

    case 'tools/call': {
      if (!isPlainObject(request.params)) {
        return buildError(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params must be an object');
      }
      const params = request.params;
      const name = params.name;
      const args = params.arguments;
      if (typeof name !== 'string' || !name) {
        return buildError(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.name required');
      }
      if (args !== undefined && !isPlainObject(args)) {
        return buildError(
          id,
          JSON_RPC_ERRORS.INVALID_PARAMS,
          'params.arguments must be an object'
        );
      }
      const tool = TOOLS.get(name);
      if (!tool) {
        return buildError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Tool not found: ${name}`);
      }
      try {
        const result = await tool.handler((args as Record<string, unknown>) ?? {}, ctx);
        return buildResult(id, result);
      } catch (err) {
        // Convert handler exceptions into MCP tool-execution errors, NOT
        // JSON-RPC-level errors: per MCP semantics, tool failures are reported
        // via isError:true in the result, not via the error envelope. This
        // lets agents see the anonymised message.
        console.warn(
          `[mcp] tool ${name} threw:`,
          (err as Error)?.message ?? String(err)
        );
        return buildResult(id, {
          content: [
            {
              type: 'text',
              text: `Tool ${name} failed. See server logs.`,
            },
          ],
          isError: true,
        });
      }
    }

    case 'resources/read': {
      if (!isPlainObject(request.params)) {
        return buildError(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params must be an object');
      }
      const uri = request.params.uri;
      if (typeof uri !== 'string' || !uri) {
        return buildError(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'params.uri required');
      }
      const res = RESOURCES.get(uri);
      if (!res) {
        return buildError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Resource not found: ${uri}`);
      }
      try {
        const content = await res.read(ctx);
        return buildResult(id, { contents: [content] });
      } catch (err) {
        console.warn(
          `[mcp] resource ${uri} threw:`,
          (err as Error)?.message ?? String(err)
        );
        return buildError(
          id,
          JSON_RPC_ERRORS.INTERNAL_ERROR,
          `Resource read failed: ${uri}`
        );
      }
    }

    // Notifications from client -> server (initialized, cancelled, etc.). We
    // acknowledge with an empty result; JSON-RPC notifications strictly should
    // not receive a response, but MCP clients send these on the same channel.
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed': {
      return buildResult(id, {});
    }

    default:
      return buildError(
        id,
        JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Method not found: ${request.method}`
      );
  }
};
