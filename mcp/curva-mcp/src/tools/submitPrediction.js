// submit_prediction — enter an open Curva prediction pool with an EIP-3009
// stake to the pool escrow.
//
// Docs verified:
//   - POST /predictions/entry (backend/src/routes/predictionRoutes.ts:383)
//     Body: { poolId, winner, homeGoals?, awayGoals?, peerHandle,
//             from, to, value, validAfter, validBefore, nonce, v, r, s }
//   - GET /predictions/pool/:roomSlug/:matchId returns the pool state including
//     poolId (CUID), mode ('winner-only'|'exact-score'), stake bounds, escrowAddress.
//     Response shape: { data: { pool: { id, mode, escrowAddress, deadlineMs, ... } } }.

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

export function registerSubmitPrediction(server) {
  server.registerTool(
    'submit_prediction',
    {
      title: 'Submit prediction stake',
      description:
        'Enter an open Curva prediction pool for a match. Signs an EIP-3009 stake to the pool escrow and posts it to the Companion. Requires explicit user approval.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
        match_id: z.string().min(1).max(64),
        winner: z.enum(['HOME', 'AWAY', 'DRAW']),
        stake_usdt: z.number().positive().max(10),
        peer_handle: z.string().min(1).max(64),
        home_goals: z.number().int().min(0).max(20).optional(),
        away_goals: z.number().int().min(0).max(20).optional(),
      },
      annotations: {
        title: 'Submit prediction stake',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const {
        room_slug,
        match_id,
        winner,
        stake_usdt,
        peer_handle,
        home_goals,
        away_goals,
      } = args;

      if (sessionSpend.stakeWouldExceed(stake_usdt)) {
        throw new Error(
          `SESSION_STAKE_CAP_EXCEEDED: ${sessionSpend.stakeRemaining()} USDT remaining of ${CONFIG.sessionStakeCapUsdt}`
        );
      }

      // Fetch pool state so we know its id, mode, escrow address, and whether
      // it is still open. The Companion is the source of truth for these.
      const poolData = await backendJson(
        `/predictions/pool/${encodeURIComponent(room_slug)}/${encodeURIComponent(match_id)}`
      );
      const pool = poolData?.pool || poolData;
      if (!pool || !pool.id) throw new Error('POOL_NOT_FOUND');
      if (pool.status && pool.status !== 'open') {
        throw new Error(`POOL_NOT_OPEN: status=${pool.status}`);
      }
      const escrow = pool.escrowAddress;
      if (!escrow || !/^0x[0-9a-fA-F]{40}$/.test(escrow)) {
        throw new Error('POOL_ESCROW_INVALID');
      }
      if (pool.mode === 'exact-score') {
        if (typeof home_goals !== 'number' || typeof away_goals !== 'number') {
          throw new Error(
            'EXACT_SCORE_REQUIRES_GOALS: pool mode is exact-score, home_goals and away_goals are required'
          );
        }
      }

      // Human confirmation.
      const scoreLine =
        pool.mode === 'exact-score'
          ? `\nScore: ${home_goals}-${away_goals}`
          : '';
      const message = [
        `Stake ${stake_usdt} USDT on ${winner} in pool "${room_slug} / ${match_id}"?`,
        `Escrow: ${escrow}`,
        `Deadline: ${new Date(Number(pool.deadlineMs)).toISOString()}`,
        `Mode: ${pool.mode}${scoreLine}`,
        `Session stakes so far: ${sessionSpend.snapshot().stakeSpent} of ${CONFIG.sessionStakeCapUsdt} USDT.`,
      ].join('\n');

      let confirm;
      try {
        confirm = await server.server.elicitInput({
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve this stake',
                description: 'Confirm you want to submit this prediction.',
              },
            },
            required: ['approve'],
          },
        });
      } catch (err) {
        logJson('warn', 'submit_prediction.elicit_unsupported', {
          message: err?.message?.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Client does not support MCP elicitation. Refusing to stake without confirmation.',
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
              text: `Stake cancelled (${confirm?.action || 'no response'}).`,
            },
          ],
        };
      }

      // Sign the EIP-3009 authorization from smartAddress to the pool escrow.
      const { smartAddress, ownerSigner } = await createCurvaWallet();
      const now = Math.floor(Date.now() / 1000);
      const validAfter = now - 60;
      const validBefore = now + 3600;
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const valueAtomic = usdtToAtomic(stake_usdt);
      const to = escrow.toLowerCase();
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
        throw new Error(`SIGN_FAILED: ${err?.message || 'unknown'}`);
      }
      const { v, r, s } = ethers.Signature.from(signature);

      // POST /predictions/entry.
      const body = {
        poolId: pool.id,
        winner,
        peerHandle: peer_handle,
        from: smartAddress,
        to,
        value: valueAtomic,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      };
      if (pool.mode === 'exact-score') {
        body.homeGoals = home_goals;
        body.awayGoals = away_goals;
      }

      let entry;
      try {
        entry = await backendJson('/predictions/entry', {
          method: 'POST',
          body,
        });
      } catch (err) {
        logJson('error', 'submit_prediction.entry_failed', {
          poolId: pool.id,
          message: err?.message,
        });
        throw err;
      }

      sessionSpend.stakeRecord(stake_usdt);
      const txHash = entry?.txHash || entry?.entry?.txHash;
      const verifyUrl = txHash
        ? `${CONFIG.backendBaseUrl}/wdk/verify/${encodeURIComponent(txHash)}`
        : null;
      const text = [
        `Staked ${stake_usdt} USDT on ${winner}${scoreLine.replace(/^\n/, ' ')}.`,
        `Pool: ${pool.id}`,
        txHash ? `Tx: ${txHash}` : 'Tx: pending',
        verifyUrl ? `Verify: ${verifyUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          poolId: pool.id,
          winner,
          stakeUsdt: stake_usdt,
          txHash: txHash ?? null,
          verifyUrl,
          sessionSpend: sessionSpend.snapshot(),
        },
      };
    }
  );
}
