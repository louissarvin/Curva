// send_tip — gasless USDT tip to the host of a Curva room.
//
// Signs an EIP-3009 TransferWithAuthorization on the OWNER EOA (not the Safe
// smart account, see wallet.js) and relays it through the Curva Companion F11
// facilitator at POST /wdk/relay/eip3009. The facilitator pays gas from the
// sponsor wallet so the tipper spends only USDT.
//
// Docs verified:
//   - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
//   - F11 facilitator route: backend/src/routes/facilitatorRoutes.ts
//     (mounted at /wdk/relay via backend/index.ts). Response shape
//     { success, data: { txHash, ... } }.
//   - Human confirmation via MCP elicitation: server.server.elicitInput per
//     https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk
//     README 'Eliciting User Input' section. Response: { action, content }.

import { z } from 'zod';
import { ethers } from 'ethers';
import { CONFIG, usdtToAtomic } from '../config.js';
import { createCurvaWallet } from '../wallet.js';
import { backendJson } from '../httpClient.js';
import { sessionSpend, assertClean, logJson } from '../safety.js';

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function buildDomain() {
  return {
    name: CONFIG.tokenName,
    version: CONFIG.tokenVersion,
    chainId: CONFIG.chainId,
    verifyingContract: CONFIG.usdtAddress,
  };
}

export function registerSendTip(server) {
  server.registerTool(
    'send_tip',
    {
      title: 'Send USDT tip',
      description:
        'Send a gasless USDT tip to the host of a Curva watch-party room. Signs an EIP-3009 TransferWithAuthorization and relays through the Curva Companion F11 facilitator. Requires explicit user approval.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
        amount_usdt: z.number().positive().max(25),
        note: z.string().max(128).optional(),
      },
      annotations: {
        title: 'Send USDT tip',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { room_slug, amount_usdt, note } = args;

      // Session cap check up front. Fail early so we do not surface an
      // elicitation dialog for a request we cannot fulfil.
      if (sessionSpend.tipWouldExceed(amount_usdt)) {
        const remaining = sessionSpend.tipRemaining();
        throw new Error(
          `SESSION_CAP_EXCEEDED: ${remaining} USDT remaining of ${CONFIG.sessionTipCapUsdt}, per-call cap ${CONFIG.perCallTipCapUsdt}`
        );
      }

      // Resolve host from the Companion. GET /rooms/:slug returns
      // { data: { room: { hostHandle, hostSmartAddress, ... } } }.
      const roomData = await backendJson(
        `/rooms/${encodeURIComponent(room_slug)}`
      );
      const room = roomData?.room;
      const hostSmart = room?.hostSmartAddress;
      const hostHandle = room?.hostHandle || 'unknown';
      if (!hostSmart) throw new Error('ROOM_NOT_FOUND');

      // Human confirmation. Elicitation may not be supported by every client;
      // wrap so we can degrade to refusal instead of auto-approving.
      const redFlag = amount_usdt >= CONFIG.redFlagUsdt;
      const message = [
        `Send ${amount_usdt} USDT to host "${hostHandle}" of room "${room_slug}"?`,
        `Host smart account: ${hostSmart}`,
        note ? `Note: ${note}` : null,
        redFlag
          ? `WARNING: amount exceeds red-flag threshold of ${CONFIG.redFlagUsdt} USDT.`
          : null,
        `Session tips so far: ${sessionSpend.snapshot().tipSpent} of ${CONFIG.sessionTipCapUsdt} USDT.`,
      ]
        .filter(Boolean)
        .join('\n');

      let confirm;
      try {
        confirm = await server.server.elicitInput({
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve this tip',
                description: 'Confirm you want to send this USDT tip.',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'send_tip.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to send the tip without explicit human confirmation.',
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
              text: `Tip cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      // Build the EIP-3009 authorization and sign with the owner EOA.
      const { smartAddress, ownerSigner } = await createCurvaWallet();
      const now = Math.floor(Date.now() / 1000);
      const validAfter = now - 60;
      const validBefore = now + 3600;
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const valueAtomic = usdtToAtomic(amount_usdt);
      const to = hostSmart.toLowerCase();

      const message712 = {
        from: smartAddress,
        to,
        value: valueAtomic,
        validAfter,
        validBefore,
        nonce,
      };

      let signature;
      try {
        signature = await ownerSigner.signTypedData(
          buildDomain(),
          EIP3009_TYPES,
          message712
        );
      } catch (err) {
        logJson('error', 'send_tip.sign_failed', { message: err?.message });
        throw new Error(`SIGN_FAILED: ${err?.message || 'unknown'}`);
      }
      const { v, r, s } = ethers.Signature.from(signature);

      // Relay via F11. Endpoint: POST /wdk/relay/eip3009.
      let relayData;
      try {
        relayData = await backendJson('/wdk/relay/eip3009', {
          method: 'POST',
          body: {
            chainId: CONFIG.chainId,
            tokenAddress: CONFIG.usdtAddress,
            from: smartAddress,
            to,
            value: valueAtomic,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s,
            roomSlug: room_slug,
            note: note ?? null,
          },
        });
      } catch (err) {
        logJson('error', 'send_tip.relay_failed', {
          roomSlug: room_slug,
          message: err?.message,
        });
        throw err;
      }

      const txHash = relayData?.txHash;
      if (!txHash) throw new Error('RELAY_NO_TX_HASH');

      // Record spend AFTER a confirmed successful relay. If the relay throws
      // above, we do not touch the counter.
      sessionSpend.tipRecord(amount_usdt);
      logJson('info', 'send_tip.relayed', {
        roomSlug: room_slug,
        amountUsdt: amount_usdt,
        txHash,
      });

      const verifyUrl = `${CONFIG.backendBaseUrl}/wdk/verify/${encodeURIComponent(txHash)}`;
      const text = [
        `Tipped ${amount_usdt} USDT to "${hostHandle}" (${hostSmart.slice(0, 8)}...).`,
        `Tx hash: ${txHash}`,
        `Verify: ${verifyUrl}`,
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          txHash,
          verifyUrl,
          amountUsdt: amount_usdt,
          roomSlug: room_slug,
          hostHandle,
          hostSmartAddress: hostSmart,
          sessionSpend: sessionSpend.snapshot(),
        },
      };
    }
  );
}
