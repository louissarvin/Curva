// verify_tip_attribution — pure read.
//
// Confirms the Curva onChainIdentifier project marker was appended to a WDK
// ERC-4337 UserOperation. Wraps the backend endpoint at
// GET /wdk/verify-attribution/:userOpHash, which does the bundler round-trip
// and the marker comparison. This tool is zero-signing, spending limit 0 USDT,
// no elicitation. Any agent can call it.
//
// Docs consulted:
//   - https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
//     (onChainIdentifier object form; platform enum)
//   - https://docs.safe.global/sdk/onchain-tracking (marker byte layout)
//   - SKILL.md capability 11 (verify_tip_attribution surface)

import { z } from 'zod';
import { backendRequest } from '../httpClient.js';
import { assertClean } from '../safety.js';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function registerVerifyTipAttribution(server) {
  server.registerTool(
    'verify_tip_attribution',
    {
      title: 'Verify tip attribution marker',
      description:
        'Verify that a WDK-relayed UserOperation was attributed to Curva via the onChainIdentifier project marker. Read-only lookup via the Curva Companion. Returns { verified, expected, observedMarker, expectedMarker, note? }.',
      inputSchema: {
        user_op_hash: z.string().regex(HASH_RE),
        chain_id: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'Verify tip attribution',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { user_op_hash, chain_id } = args;
      const query = chain_id ? { chainId: chain_id } : undefined;
      const path = `/wdk/verify-attribution/${user_op_hash}`;

      const { status, payload } = await backendRequest(path, {
        method: 'GET',
        query,
      });

      if (status === 200 && payload?.success !== false) {
        const data = payload?.data ?? payload;
        const expected = data.expected ?? {};
        const lines = [];
        if (data.verified) {
          lines.push('Attribution: VERIFIED');
          lines.push(`Project: ${expected.project}`);
          lines.push(`Platform: ${expected.platform}`);
          lines.push(`Tool: ${expected.tool} v${expected.toolVersion}`);
          lines.push(`Marker: 0x${data.observedMarker}`);
        } else {
          lines.push('Attribution: ABSENT');
          if (data.note) lines.push(`Reason: ${data.note}`);
          lines.push(`Expected marker: 0x${data.expectedMarker}`);
          lines.push(
            data.observedMarker
              ? `Observed marker: 0x${data.observedMarker}`
              : 'Observed marker: n/a'
          );
        }
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: data,
        };
      }

      // Non-200 or explicit failure envelope. Never throw — the caller renders
      // the error state itself.
      const errCode = payload?.error?.code || 'ATTRIBUTION_LOOKUP_FAILED';
      const errMsg = payload?.error?.message || `HTTP ${status}`;
      return {
        content: [
          {
            type: 'text',
            text: `Attribution lookup failed (${errCode}): ${errMsg}`,
          },
        ],
        structuredContent: {
          verified: false,
          status,
          errorCode: errCode,
          errorMessage: errMsg,
        },
        isError: true,
      };
    }
  );
}
