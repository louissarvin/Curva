// tip_batch — batched USDT tips packed into ONE ERC-4337 UserOperation.
//
// Sends tips to 2..5 recipients via a single Safe multiSend delegatecall. One
// signature on the OWNER EOA. One on-chain transaction with N ERC-20 Transfer
// events. Backend `/wdk/relay/batch` bridges to the pear-app Bare worker which
// calls `account.sendTransaction([...])` on the WDK ERC-4337 account.
//
// Docs verified:
//   - https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
//     `sendTransaction(tx | tx[])` returns `{ hash, fee }`; when passed an
//     array the SDK emits ONE UserOperation containing all calls (verified
//     against pear-app/node_modules/@tetherto/wdk-wallet-evm-erc-4337/src/
//     wallet-account-evm-erc-4337.js line 282).
//   - https://docs.wdk.tether.io/ai/mcp-toolkit/api-reference/
//     elicitation flow is `server.server.elicitInput({ message,
//     requestedSchema })` returning `{ action, content }` (same pattern the
//     existing send_tip / mint_attendance_pass tools use).
//   - SKILL.md capability 9: per-call cap 15 USDT, per-session cap 25 USDT.
//   - EIP-3009 path is intentionally NOT used for batches (the F11 facilitator
//     handles one TransferWithAuthorization per HTTP call by design; batching
//     lives on the ERC-4337 path only).

import { z } from 'zod';
import { CONFIG } from '../config.js';
import { backendRequest } from '../httpClient.js';
import { sessionSpend, assertClean, logJson } from '../safety.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Per-call ceiling per recipient. Uses the shared perCallTipCap from config
// (15 USDT default) so a single tip and a batched tip share the same wallet
// safety envelope.
const RecipientSchema = z.object({
  address: z.string().regex(ADDR_RE, 'address must be 0x + 20-byte hex'),
  amount_usdt: z.number().positive().max(15),
});

export function registerTipBatch(server) {
  server.registerTool(
    'tip_batch',
    {
      title: 'Send batch USDT tips (one UserOperation)',
      description:
        'Send USDT tips to 2..5 recipients in a single ERC-4337 UserOperation. One signature on the owner EOA, one on-chain transaction with N Transfer events, atomic (all-or-nothing). Requires explicit user approval via MCP elicitation.',
      inputSchema: {
        recipients: z.array(RecipientSchema).min(2).max(5),
        note: z.string().max(280).optional(),
      },
      annotations: {
        title: 'Send batch USDT tips',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { recipients, note } = args;

      // Client-side dedupe. WDK does not dedupe, so a duplicate address in
      // the batch would result in TWO Transfer events debiting the sender
      // twice. Refuse instead of silently double-charging.
      const seen = new Set();
      for (const r of recipients) {
        const key = r.address.toLowerCase();
        if (seen.has(key)) {
          return {
            content: [
              {
                type: 'text',
                text: `Duplicate recipient address ${r.address} in batch. Every address must be unique.`,
              },
            ],
            isError: true,
          };
        }
        seen.add(key);
      }

      // Per-call cap enforcement (belt-and-braces with zod .max(15)).
      for (const r of recipients) {
        if (r.amount_usdt > CONFIG.perCallTipCapUsdt) {
          return {
            content: [
              {
                type: 'text',
                text: `Per-recipient amount ${r.amount_usdt} USDT exceeds per-call cap ${CONFIG.perCallTipCapUsdt} USDT.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Total across the batch must fit inside session cap. sessionSpend
      // tracks decimal USDT so we sum floats here (bounded by 5 * 15 = 75).
      const totalUsdt = recipients.reduce((s, r) => s + r.amount_usdt, 0);
      if (sessionSpend.tipWouldExceed(totalUsdt)) {
        const remaining = sessionSpend.tipRemaining();
        return {
          content: [
            {
              type: 'text',
              text: `Batch total ${totalUsdt} USDT would exceed session cap. Remaining budget: ${remaining} USDT of ${CONFIG.sessionTipCapUsdt}.`,
            },
          ],
          isError: true,
        };
      }

      // Elicitation with full recipient breakdown. Mirrors the send_tip
      // pattern so hosts render the same confirmation UI.
      const breakdown = recipients
        .map((r, i) => `  ${i + 1}. ${r.address} = ${r.amount_usdt} USDT`)
        .join('\n');
      const message = [
        `Send ${totalUsdt} USDT across ${recipients.length} recipients as ONE UserOperation?`,
        breakdown,
        note ? `Note: ${note}` : null,
        `This is a single signature. If the batch reverts, no transfer happens.`,
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
                title: 'Approve batch tip',
                description: 'Confirm the batched UserOperation.',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'tip_batch.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to send the batch without explicit human confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (confirm?.action !== 'accept' || confirm.content?.approve !== true) {
        return {
          content: [
            {
              type: 'text',
              text: `Batch tip cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      // Convert to base units (6 decimals) as strings so the backend can pass
      // them straight through to the Bare worker without float drift.
      const payload = {
        recipients: recipients.map((r) => ({
          address: r.address.toLowerCase(),
          amount: String(BigInt(Math.round(r.amount_usdt * 1_000_000))),
        })),
        note: note ?? null,
        chainId: CONFIG.chainId,
      };

      const { status, payload: body } = await backendRequest(
        '/wdk/relay/batch',
        {
          method: 'POST',
          body: payload,
        }
      );

      if (status < 200 || status >= 300 || body?.success === false) {
        const code = body?.error?.code || `HTTP_${status}`;
        const msg = body?.error?.message || `HTTP ${status}`;
        logJson('error', 'tip_batch.propose_failed', {
          status,
          code,
          message: msg,
        });
        return {
          content: [
            { type: 'text', text: `Batch tip failed: ${code}: ${msg}` },
          ],
          isError: true,
        };
      }

      const data = body?.data ?? {};
      const userOpHash = data.userOpHash || data.hash || null;
      if (!userOpHash) {
        logJson('error', 'tip_batch.no_hash', { status });
        return {
          content: [
            {
              type: 'text',
              text: 'Backend did not return a userOpHash; refusing to claim success.',
            },
          ],
          isError: true,
        };
      }

      // Record spend AFTER a confirmed successful relay so a transport failure
      // above never leaks into the session ledger.
      sessionSpend.tipRecord(totalUsdt);

      const explorerBase =
        data.explorerBase ||
        (CONFIG.chainId === 11155111
          ? 'https://sepolia.etherscan.io/tx/'
          : 'https://etherscan.io/tx/');
      const etherscanUrl = data.etherscanUrl || `${explorerBase}${userOpHash}`;
      const count = data.count ?? recipients.length;

      logJson('info', 'tip_batch.relayed', {
        userOpHash,
        count,
        totalUsdt,
      });

      const text = [
        `Batch tip sent as ONE UserOperation.`,
        `UserOp hash: ${userOpHash}`,
        `Recipients: ${count}`,
        `Total: ${totalUsdt} USDT`,
        `Explorer: ${etherscanUrl}`,
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          userOpHash,
          count,
          totalUsdt,
          etherscanUrl,
          chainId: CONFIG.chainId,
          sessionSpend: sessionSpend.snapshot(),
        },
      };
    }
  );
}
