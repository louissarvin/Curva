/**
 * F14 MCP server dispatcher unit tests.
 *
 * Covers: JSON-RPC envelope validation, initialize, ping, method-not-found,
 * tools/list + resources/list, tools/call with an unknown tool, resources/read
 * with an unknown URI.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  handleRpc,
  registerResource,
  registerTool,
  __resetRegistryForTest,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  JSON_RPC_ERRORS,
  type McpContext,
} from '../../../src/lib/mcp/server.ts';

const CTX: McpContext = { lang: 'en', ip: '127.0.0.1' };

beforeAll(() => {
  __resetRegistryForTest();
  registerTool({
    name: 'echo',
    description: 'Echo the input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async handler(args) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ echo: args.text ?? null }) },
        ],
        structuredContent: { echo: args.text ?? null },
      };
    },
  });
  registerTool({
    name: 'boom',
    description: 'Always throws',
    inputSchema: { type: 'object' },
    async handler() {
      throw new Error('boom');
    },
  });
  registerResource({
    uri: 'test://hello',
    name: 'hello',
    description: 'Hello world text',
    mimeType: 'text/plain',
    async read() {
      return { uri: 'test://hello', mimeType: 'text/plain', text: 'hi' };
    },
  });
});

afterAll(() => {
  __resetRegistryForTest();
});

describe('handleRpc envelope', () => {
  test('rejects non-2.0 jsonrpc', async () => {
    const res = await handleRpc(
      { jsonrpc: '1.0' as unknown as '2.0', id: 1, method: 'ping' },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  test('rejects missing method', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: '' } as unknown as {
        jsonrpc: '2.0';
        id: number;
        method: string;
      },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });
});

describe('initialize', () => {
  test('returns protocol version + server info', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools?: unknown; resources?: unknown };
    };
    expect(r.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(r.capabilities.tools).toBeDefined();
    expect(r.capabilities.resources).toBeDefined();
  });
});

describe('ping', () => {
  test('returns empty result', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 42, method: 'ping' },
      CTX
    );
    expect(res.error).toBeUndefined();
    expect(res.id).toBe(42);
    expect(res.result).toEqual({});
  });
});

describe('tools/list', () => {
  test('returns registered tools with metadata', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 'a', method: 'tools/list' },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(Array.isArray(r.tools)).toBe(true);
    const names = r.tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('boom');
    const echo = r.tools.find((t) => t.name === 'echo');
    expect(echo?.inputSchema).toBeDefined();
  });
});

describe('tools/call', () => {
  test('dispatches to a registered tool', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as {
      content: Array<{ type: string; text?: string }>;
      structuredContent: { echo: string };
    };
    expect(r.content[0]?.type).toBe('text');
    expect(r.structuredContent.echo).toBe('hi');
  });

  test('unknown tool returns METHOD_NOT_FOUND', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'nope' },
      },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  test('tool handler exception is converted to isError result', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'boom' },
      },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as { isError: boolean };
    expect(r.isError).toBe(true);
  });

  test('missing params.name returns INVALID_PARAMS', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { arguments: {} },
      },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
  });
});

describe('resources/list + resources/read', () => {
  test('list returns registered resources', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as { resources: Array<{ uri: string }> };
    expect(r.resources.map((x) => x.uri)).toContain('test://hello');
  });

  test('read a known URI returns text content', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'test://hello' },
      },
      CTX
    );
    expect(res.error).toBeUndefined();
    const r = res.result as {
      contents: Array<{ uri: string; text: string }>;
    };
    expect(r.contents[0]?.uri).toBe('test://hello');
    expect(r.contents[0]?.text).toBe('hi');
  });

  test('read unknown URI returns METHOD_NOT_FOUND', async () => {
    const res = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'test://missing' },
      },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });
});

describe('unknown method', () => {
  test('returns METHOD_NOT_FOUND', async () => {
    const res = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'nope' },
      CTX
    );
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });
});
