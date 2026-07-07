// pay_x402_resource — pay for an x402-gated HTTP resource. Two-legged flow:
//   1. GET the resource, receive 402 with body { x402Version, accepts: [...] }
//   2. Pick the first accept, sign EIP-3009 matching its terms, retry with
//      X-Payment header carrying { from, to, value, validAfter, validBefore,
//      nonce, v, r, s, network, tokenAddress }.
//
// The Curva Companion x402 endpoint (backend/src/routes/x402Routes.ts) uses the
// F11 facilitator internally to settle the payment. Response on success carries
// X-Payment-Response header with the settlement txHash.

import { z } from 'zod';
import { ethers } from 'ethers';
import { request as undiciRequest } from 'undici';
import { CONFIG } from '../config.js';
import { createCurvaWallet } from '../wallet.js';
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

// Extract chainId from CAIP-2 network string 'eip155:<n>'.
function chainIdFromNetwork(network) {
  if (typeof network !== 'string') return null;
  const m = network.match(/^eip155:(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function registerPayX402Resource(server) {
  server.registerTool(
    'pay_x402_resource',
    {
      title: 'Pay for x402 resource',
      description:
        'Fetch an x402-gated HTTPS resource. If the server returns 402 Payment Required, sign an EIP-3009 authorization matching the challenge and retry with the X-Payment header. Requires explicit user approval.',
      inputSchema: {
        resource_url: z.string().url(),
        max_price_atomic: z.string().regex(/^\d+$/).optional(),
      },
      annotations: {
        title: 'Pay for x402 resource',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { resource_url, max_price_atomic } = args;

      // Per-call cap (default 1 USDT). Enforced BEFORE the network call.
      const maxAtomic = max_price_atomic
        ? BigInt(max_price_atomic)
        : BigInt(Math.round(CONFIG.perCallX402CapUsdt * 1_000_000));

      // Leg 1: probe the resource for a 402 challenge.
      let probe;
      try {
        probe = await undiciRequest(resource_url, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
      } catch (err) {
        throw new Error(`X402_UNREACHABLE: ${err?.message || 'unknown'}`);
      }

      if (probe.statusCode !== 402) {
        // Already paid (cached unlock) OR no payment required at all.
        const body = await probe.body.text();
        return {
          content: [
            {
              type: 'text',
              text: `Resource returned ${probe.statusCode} without a payment challenge. Body: ${body.slice(0, 400)}`,
            },
          ],
          structuredContent: { status: probe.statusCode, body: body.slice(0, 2000) },
        };
      }

      let challenge;
      try {
        challenge = await probe.body.json();
      } catch {
        throw new Error('X402_CHALLENGE_MALFORMED: 402 body was not JSON');
      }
      const accept = challenge?.accepts?.[0];
      if (!accept) throw new Error('X402_NO_ACCEPTS');
      if (accept.scheme !== 'exact') {
        throw new Error(`X402_SCHEME_UNSUPPORTED: ${accept.scheme}`);
      }
      const challengeChainId = chainIdFromNetwork(accept.network);
      if (!challengeChainId) throw new Error('X402_NETWORK_INVALID');
      if (challengeChainId !== CONFIG.chainId) {
        throw new Error(
          `X402_CHAIN_MISMATCH: challenge is on chainId ${challengeChainId}, wallet is on ${CONFIG.chainId}`
        );
      }
      if (accept.asset?.toLowerCase() !== CONFIG.usdtAddress) {
        throw new Error(`X402_ASSET_UNSUPPORTED: ${accept.asset}`);
      }
      const priceAtomic = BigInt(accept.maxAmountRequired);
      if (priceAtomic > maxAtomic) {
        throw new Error(
          `X402_PRICE_EXCEEDS_CAP: challenge asks ${priceAtomic} atomic, cap is ${maxAtomic}`
        );
      }
      const priceUsdt = Number(priceAtomic) / 1_000_000;

      // Human confirmation.
      const elicitMessage = [
        `Pay ${priceUsdt} USDT to unlock ${resource_url}?`,
        `Recipient: ${accept.payTo}`,
        accept.description ? `Description: ${accept.description}` : null,
        `Session x402 spend so far: ${sessionSpend.snapshot().x402Spent} USDT`,
      ]
        .filter(Boolean)
        .join('\n');
      let confirm;
      try {
        confirm = await server.server.elicitInput({
          message: elicitMessage,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve this payment',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'pay_x402_resource.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to pay.',
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
              text: `Payment cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      // Sign EIP-3009 matching the challenge fields exactly.
      const { smartAddress, ownerSigner } = await createCurvaWallet();
      const message712 = {
        from: smartAddress,
        to: accept.payTo.toLowerCase(),
        value: String(priceAtomic),
        validAfter: accept.validAfter,
        validBefore: accept.validBefore,
        nonce: accept.nonce,
      };
      const signature = await ownerSigner.signTypedData(
        {
          name: CONFIG.tokenName,
          version: CONFIG.tokenVersion,
          chainId: CONFIG.chainId,
          verifyingContract: CONFIG.usdtAddress,
        },
        EIP3009_TYPES,
        message712
      );
      const { v, r, s } = ethers.Signature.from(signature);

      const paymentHeader = JSON.stringify({
        scheme: 'exact',
        network: accept.network,
        tokenAddress: CONFIG.usdtAddress,
        from: smartAddress,
        to: accept.payTo.toLowerCase(),
        value: String(priceAtomic),
        validAfter: accept.validAfter,
        validBefore: accept.validBefore,
        nonce: accept.nonce,
        v,
        r,
        s,
      });

      // Leg 2: retry with the payment header.
      let paid;
      try {
        paid = await undiciRequest(resource_url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'X-Payment': paymentHeader,
          },
        });
      } catch (err) {
        throw new Error(`X402_SETTLE_TRANSPORT: ${err?.message || 'unknown'}`);
      }
      const paidBody = await paid.body.text();
      if (paid.statusCode !== 200) {
        throw new Error(
          `X402_SETTLE_FAILED: HTTP ${paid.statusCode}: ${paidBody.slice(0, 300)}`
        );
      }
      const settlementTx = String(paid.headers['x-payment-response'] || '') || null;
      sessionSpend.x402Record(priceUsdt);
      logJson('info', 'pay_x402_resource.settled', {
        resource: resource_url,
        priceUsdt,
        settlementTx,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `Paid ${priceUsdt} USDT to ${accept.payTo} for ${resource_url}.`,
              settlementTx ? `Settlement tx: ${settlementTx}` : 'Settlement tx: not returned',
              `Response body: ${paidBody.slice(0, 500)}`,
            ].join('\n'),
          },
        ],
        structuredContent: {
          resourceUrl: resource_url,
          priceUsdt,
          priceAtomic: String(priceAtomic),
          payTo: accept.payTo,
          settlementTx,
          responseBody: paidBody.slice(0, 2000),
          sessionSpend: sessionSpend.snapshot(),
        },
      };
    }
  );
}
