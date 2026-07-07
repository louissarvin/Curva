// open_prediction_pool — host opens a prediction pool for a match. No value
// transfer; the host commits to a public pool by signing an EIP-191 personal
// message with the schema below and POSTing it to POST /predictions/open.
//
// Signed message format (matches backend/src/lib/evm/predictionPool.ts):
//   curva-predictions-open:<roomSlug>:<matchId>:<deadlineMs>:<mode>
//
// This is a signature-only capability but we still elicit confirmation because
// opening a pool publicly commits the host's identity to a match.

import { z } from 'zod';
import { CONFIG } from '../config.js';
import { createCurvaWallet } from '../wallet.js';
import { backendJson } from '../httpClient.js';
import { assertClean, logJson } from '../safety.js';

export function registerOpenPredictionPool(server) {
  server.registerTool(
    'open_prediction_pool',
    {
      title: 'Open prediction pool',
      description:
        'Host action: open a Curva prediction pool for a match. Signs an EIP-191 message and posts it to the Companion. Requires explicit user approval. No USDT is transferred.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
        match_id: z.string().min(1).max(64),
        mode: z.enum(['winner-only', 'exact-score']),
        deadline_iso: z.string().datetime(),
      },
      annotations: {
        title: 'Open prediction pool',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { room_slug, match_id, mode, deadline_iso } = args;
      const deadlineMs = Date.parse(deadline_iso);
      if (!Number.isFinite(deadlineMs)) {
        throw new Error('DEADLINE_INVALID: deadline_iso must be an ISO-8601 timestamp');
      }
      if (deadlineMs <= Date.now() + 60_000) {
        throw new Error('DEADLINE_TOO_SOON: deadline must be > 60s in the future');
      }

      const { ownerAddress, ownerSigner } = await createCurvaWallet();

      const elicitMessage = [
        `Open a "${mode}" prediction pool for match "${match_id}" in room "${room_slug}"?`,
        `Deadline: ${new Date(deadlineMs).toISOString()}`,
        `You sign as host EOA: ${ownerAddress}`,
      ].join('\n');

      let confirm;
      try {
        confirm = await server.server.elicitInput({
          message: elicitMessage,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve opening this pool',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'open_prediction_pool.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to open the pool.',
            },
          ],
          isError: true,
        };
      }
      if (confirm?.action !== 'accept' || !confirm.content?.approve) {
        return {
          content: [
            {
              type: 'text',
              text: `Pool opening cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      // EIP-191 personal_sign over the canonical Curva message.
      const messageBytes = `curva-predictions-open:${room_slug}:${match_id}:${deadlineMs}:${mode}`;
      let signature;
      try {
        signature = await ownerSigner.signMessage(messageBytes);
      } catch (err) {
        throw new Error(`SIGN_FAILED: ${err?.message || 'unknown'}`);
      }

      let data;
      try {
        data = await backendJson('/predictions/open', {
          method: 'POST',
          body: {
            roomSlug: room_slug,
            matchId: match_id,
            mode,
            deadlineMs,
            hostAddress: ownerAddress,
            signature,
          },
        });
      } catch (err) {
        logJson('error', 'open_prediction_pool.post_failed', {
          roomSlug: room_slug,
          matchId: match_id,
          message: err?.message,
        });
        throw err;
      }

      const pool = data?.pool || data;
      const text = [
        `Pool opened for ${room_slug} / ${match_id}`,
        pool?.id ? `Pool id: ${pool.id}` : null,
        `Mode: ${mode}`,
        `Deadline: ${new Date(deadlineMs).toISOString()}`,
        pool?.escrowAddress ? `Escrow: ${pool.escrowAddress}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          pool: pool ?? null,
          hostAddress: ownerAddress,
          deadlineMs,
          companionUrl: `${CONFIG.backendBaseUrl}/predictions/pool/${encodeURIComponent(room_slug)}/${encodeURIComponent(match_id)}`,
        },
      };
    }
  );
}
