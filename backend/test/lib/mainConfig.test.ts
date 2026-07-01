/**
 * main-config.ts smoke tests. Guards defaults that have security implications.
 *
 * MCP_TOOL_PREPARE_TIP_ENABLED must default to `false` (SECURITY_AUDIT HIGH-01):
 * enabling this tool without an MCP_ACCESS_TOKEN exposes host smart-account
 * addresses to anonymous scrapers per OWASP API3:2023.
 *
 * setup.ts (bunfig test preload) does NOT set MCP_TOOL_PREPARE_TIP_ENABLED,
 * so the imported value is the code-level default.
 */

import { describe, expect, test } from 'bun:test';

describe('main-config MCP_TOOL_PREPARE_TIP_ENABLED default', () => {
  test('is false when the env var is unset in the test env', async () => {
    // The env var must not be set for this assertion to be meaningful.
    expect(process.env.MCP_TOOL_PREPARE_TIP_ENABLED).toBeUndefined();
    const { MCP_TOOL_PREPARE_TIP_ENABLED } = await import(
      '../../src/config/main-config.ts'
    );
    expect(MCP_TOOL_PREPARE_TIP_ENABLED).toBe(false);
  });
});
