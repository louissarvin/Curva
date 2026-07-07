// mint_attendance_pass — host signs an EIP-191 attendance pass for a peer.
// Off-chain, no gas, no on-chain settlement. Any third party can ecrecover the
// signer to prove the peer was in the room at issuedAt.
//
// Signed message format (matches backend/src/lib/evm/attendance.ts):
//   curva-attendance-pass:v1:<slug>:<matchId|"">:<peerAddress>:<issuedAt>
//
// Verification uses GET /wdk/verify-attendance/:slug/:address; the pass is
// broadcast to the room's chat / hyperbee out-of-band by the Pear peer, not
// by the Companion. Backend rate-limit: 3 passes / peer / hour on the host
// side is enforced client-side by the pear-app; the MCP surface does not
// re-implement it because MCP-issued passes bypass the pear-app's log.

import { z } from 'zod';
import { CONFIG } from '../config.js';
import { createCurvaWallet } from '../wallet.js';
import { assertClean, logJson } from '../safety.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function registerMintAttendancePass(server) {
  server.registerTool(
    'mint_attendance_pass',
    {
      title: 'Mint attendance pass',
      description:
        'Host action: sign an EIP-191 attendance pass for a peer address. Off-chain only; no gas, no USDT. Elicits confirmation because the peer address is disclosed to the signer.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
        peer_address: z.string().regex(ADDR_RE, 'must be 0x + 40 hex chars'),
        match_id: z.string().min(1).max(64).optional(),
      },
      annotations: {
        title: 'Mint attendance pass',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      assertClean(args);
      const { room_slug, peer_address, match_id } = args;
      const peerLower = peer_address.toLowerCase();

      const { ownerAddress, ownerSigner } = await createCurvaWallet();

      // Elicitation. Docs recommend but do not mandate for signature-only ops.
      // We surface the peer address so the user knows what they are attesting to.
      let confirm;
      try {
        confirm = await server.server.elicitInput({
          message: [
            `Mint an attendance pass for peer ${peerLower} in room "${room_slug}"?`,
            match_id ? `Match: ${match_id}` : null,
            `You sign as host EOA: ${ownerAddress}`,
          ]
            .filter(Boolean)
            .join('\n'),
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve minting this pass',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'mint_attendance_pass.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to mint without confirmation.',
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
              text: `Attendance pass cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      const issuedAt = Math.floor(Date.now() / 1000);
      const messageBytes = `curva-attendance-pass:v1:${room_slug}:${match_id || ''}:${peerLower}:${issuedAt}`;
      let signature;
      try {
        signature = await ownerSigner.signMessage(messageBytes);
      } catch (err) {
        throw new Error(`SIGN_FAILED: ${err?.message || 'unknown'}`);
      }

      const verifyUrl =
        `${CONFIG.backendBaseUrl}/wdk/verify-attendance/${encodeURIComponent(room_slug)}/${peerLower}` +
        `?signature=${encodeURIComponent(signature)}&issuedAt=${issuedAt}` +
        (match_id ? `&matchId=${encodeURIComponent(match_id)}` : '');

      logJson('info', 'mint_attendance_pass.signed', {
        roomSlug: room_slug,
        peerAddress: peerLower,
        matchId: match_id ?? null,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `Attendance pass signed for ${peerLower} in "${room_slug}".`,
              `Issued at (unix): ${issuedAt}`,
              `Signature: ${signature}`,
              `Verify: ${verifyUrl}`,
            ].join('\n'),
          },
        ],
        structuredContent: {
          roomSlug: room_slug,
          peerAddress: peerLower,
          matchId: match_id ?? null,
          issuedAt,
          signature,
          hostAddress: ownerAddress,
          verifyUrl,
        },
      };
    }
  );
}
