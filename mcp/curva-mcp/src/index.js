#!/usr/bin/env node
// curva-mcp stdio entrypoint. Connects the WdkMcpServer to
// StdioServerTransport per https://docs.wdk.tether.io/ai/mcp-toolkit/get-started/.
//
// stdio hosts (Claude Desktop, Cursor) speak JSON-RPC over stdin/stdout.
// stdout MUST carry only protocol frames; all diagnostics go to stderr via
// safety.js logJson().

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { forgetWallet } from './wallet.js';
import { logJson } from './safety.js';

let server;
try {
  server = await buildServer();
} catch (err) {
  logJson('fatal', 'bootstrap.failed', { message: err?.message });
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
}

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  logJson('info', 'stdio.connected', {});
} catch (err) {
  logJson('fatal', 'stdio.connect_failed', { message: err?.message });
  process.exit(1);
}

// Graceful shutdown so WDK wipes keys per docs.
async function shutdown(signal) {
  logJson('info', 'shutdown', { signal });
  try {
    await server.close?.();
  } catch (err) {
    logJson('warn', 'shutdown.close_failed', { message: err?.message });
  }
  forgetWallet();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Unhandled errors go to stderr; never let a crash dump leak to stdout.
process.on('uncaughtException', (err) => {
  logJson('fatal', 'uncaught_exception', { message: err?.message });
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logJson('fatal', 'unhandled_rejection', {
    message: (reason && reason.message) || String(reason),
  });
});
