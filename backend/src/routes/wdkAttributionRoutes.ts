/**
 * WDK attribution verification route (F15 Wave 11 add-on).
 *
 *   GET /wdk/verify-attribution/:userOpHash?chainId=<n>
 *
 * Purpose: given a UserOp hash produced by the WDK ERC-4337 pathway, fetch the
 * UserOp from the bundler, slice the last 64 hex chars of `callData`, and
 * compare against the locally-computed Curva project marker. Matches prove
 * that the tip UserOp carried the Curva onChainIdentifier attribution.
 *
 * Auth: none. The endpoint is a public verifier over already-public bundler
 * state, mirroring the pattern of GET /wdk/verify/:txHash.
 *
 * Docs consulted (2026-07-06):
 *   - https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
 *     (onChainIdentifier object form, closed `platform` enum:
 *     'Web' | 'Mobile' | 'Safe App' | 'Widget')
 *   - https://docs.safe.global/sdk/onchain-tracking (canonical 50-byte marker
 *     field layout: prefix(2) + version(1) + projectHash(20) + platformHash(3)
 *     + toolHash(3) + toolVersionHash(3))
 *   - Local source: pear-app/node_modules/abstractionkit/dist/index.mjs line
 *     6142, function `generateOnChainIdentifier`. The runtime marker is 64 hex
 *     chars appended to callData (32 raw bytes). Safe's "50 bytes" wording
 *     refers to the double-hex decoding of the tail; the appended suffix is
 *     always exactly 64 hex chars.
 *
 * The verifier NEVER trusts the marker to recover project/platform/tool: the
 * fields are keccak-truncated hashes, so the only sound check is equality with
 * a marker computed locally for the known Curva parameters.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ethers } from 'ethers';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { getChain, DEFAULT_CHAIN_ID } from '../lib/evm/chains.ts';

// =============================================================================
// Curva attribution constants. `platform` MUST come from the closed enum in the
// WDK docs. 'Widget' maps cleanest to the Pear runtime (see
// memory/impl_onchain_identifier.md gotcha 3). The pear-app worklet ships this
// same object into `factoryOptions.onChainIdentifier`.
// =============================================================================

export const CURVA_MARKER_PARAMS = {
  project: 'curva',
  platform: 'Widget',
  tool: 'curva-wallet',
  toolVersion: '0.1.0',
} as const;

// =============================================================================
// Bundler URL resolver.
//
// `chains.json` does not carry a per-chain `bundlerUrl` field (F10 was scoped
// to the tip indexer, not user-op fetch). Sepolia uses Candide's public
// bundler; Plasma is served by Gelato / Thirdweb / ZeroDev per Plasma docs and
// is intentionally NOT wired here (chain 9746 stays disabled until USDT0
// publishes; see backend/src/data/chains.json notes for chainId 9746).
// =============================================================================

const CANDIDE_PUBLIC_BASE = 'https://api.candide.dev/public/v3';

const getBundlerUrl = (chainId: number): string | null => {
  // Only Sepolia is wired at ship time. Add other chains here as bundler
  // partners are confirmed (see memory/impl_onchain_identifier.md gotcha 6).
  if (chainId === 11155111) return `${CANDIDE_PUBLIC_BASE}/${chainId}`;
  return null;
};

// =============================================================================
// Marker computation.
//
// Port of abstractionkit `generateOnChainIdentifier` at
// pear-app/node_modules/abstractionkit/dist/index.mjs line 6142. Verified
// character-for-character against the source; DO NOT refactor for "clarity"
// without re-checking the double-hex behaviour described in
// memory/impl_onchain_identifier.md.
//
// Field widths in the returned suffix (all lowercase hex chars, no 0x):
//   bytes  0..3  = "5afe"                     prefix literal
//   bytes  4..5  = "00"                       version literal
//   bytes  6..45 = ASCII-hex of last 20 hex chars of keccak256(utf8(project))
//   bytes 46..51 = ASCII-hex of last 3 hex chars of keccak256(utf8(platform))
//   bytes 52..57 = ASCII-hex of last 3 hex chars of keccak256(utf8(tool))
//   bytes 58..63 = ASCII-hex of last 3 hex chars of keccak256(utf8(toolVersion))
// Total: 64 hex chars = 32 raw bytes appended to callData.
// =============================================================================

const asciiHex = (s: string): string =>
  ethers.hexlify(ethers.toUtf8Bytes(s)).slice(2);

const keccakUtf8 = (s: string): string =>
  ethers.keccak256(ethers.hexlify(ethers.toUtf8Bytes(s)));

export function generateExpectedMarker(params: {
  project: string;
  platform: string;
  tool: string;
  toolVersion: string;
}): string {
  const projectHash = keccakUtf8(params.project).slice(-20);
  const platformHash = keccakUtf8(params.platform).slice(-3);
  const toolHash = keccakUtf8(params.tool).slice(-3);
  const toolVersionHash = keccakUtf8(params.toolVersion).slice(-3);
  return (
    '5afe00' +
    asciiHex(projectHash) +
    asciiHex(platformHash) +
    asciiHex(toolHash) +
    asciiHex(toolVersionHash)
  );
}

// =============================================================================
// Route plugin
// =============================================================================

interface VerifyAttributionResponse {
  verified: boolean;
  expected: {
    project: string;
    platform: string;
    tool: string;
    toolVersion: string;
  };
  expectedMarker: string;
  observedMarker: string | null;
  userOpHash: string;
  chainId: number;
  note?: string;
}

export const wdkAttributionRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/verify-attribution/:userOpHash',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { userOpHash: string };
        Querystring: { chainId?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { userOpHash } = request.params;
        if (
          typeof userOpHash !== 'string' ||
          !ethers.isHexString(userOpHash, 32)
        ) {
          return handleError(
            reply,
            404,
            'userOpHash must be a 0x-prefixed 32-byte hex value',
            'VALIDATION_ERROR'
          );
        }
        const normalizedHash = userOpHash.toLowerCase();

        // Chain resolution. Default to Sepolia per ADR-009. Unknown or
        // bundler-less chains get a 200 envelope with `note` explaining the
        // gap so the caller can render a clean "attribution unavailable"
        // state instead of an error banner.
        const rawChainId = request.query?.chainId;
        const chainId = rawChainId ? Number(rawChainId) : DEFAULT_CHAIN_ID;
        if (!Number.isFinite(chainId) || !Number.isInteger(chainId)) {
          return handleError(
            reply,
            400,
            'chainId must be an integer',
            'VALIDATION_ERROR'
          );
        }
        const chain = getChain(chainId);
        const expectedMarker = generateExpectedMarker(CURVA_MARKER_PARAMS);

        const baseResponse: VerifyAttributionResponse = {
          verified: false,
          expected: { ...CURVA_MARKER_PARAMS },
          expectedMarker,
          observedMarker: null,
          userOpHash: normalizedHash,
          chainId,
        };

        if (!chain) {
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              ...baseResponse,
              note: 'chain_not_configured',
            },
          });
        }

        const bundlerUrl = getBundlerUrl(chainId);
        if (!bundlerUrl) {
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              ...baseResponse,
              note: 'bundler_not_configured',
            },
          });
        }

        // eth_getUserOperationByHash per ERC-4337 v0.7. Timeout is deliberate
        // to keep a stalled bundler from parking a request handler.
        const rpcBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getUserOperationByHash',
          params: [normalizedHash],
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);

        let rpcJson: {
          result?: { callData?: string } | null;
          error?: { message?: string; code?: number } | null;
        };
        try {
          const rpcRes = await fetch(bundlerUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(rpcBody),
            signal: controller.signal,
          });
          if (!rpcRes.ok) {
            // Structured log so ops sees WHICH upstream failed, but the client
            // gets the generic bundler_unreachable envelope.
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'attribution.bundler_http',
                chainId,
                status: rpcRes.status,
                userOpHash: normalizedHash,
              })
            );
            return reply.code(200).send({
              success: true,
              error: null,
              data: { ...baseResponse, note: 'bundler_unreachable' },
            });
          }
          rpcJson = (await rpcRes.json()) as typeof rpcJson;
        } catch (err) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'attribution.bundler_transport',
              chainId,
              userOpHash: normalizedHash,
              message: (err as Error)?.message?.slice(0, 200) ?? 'unknown',
            })
          );
          return reply.code(200).send({
            success: true,
            error: null,
            data: { ...baseResponse, note: 'bundler_unreachable' },
          });
        } finally {
          clearTimeout(timer);
        }

        if (rpcJson.error) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'attribution.bundler_rpc_error',
              chainId,
              userOpHash: normalizedHash,
              rpcMessage: String(rpcJson.error?.message ?? '').slice(0, 200),
            })
          );
          return reply.code(200).send({
            success: true,
            error: null,
            data: { ...baseResponse, note: 'bundler_rpc_error' },
          });
        }

        const callData = rpcJson.result?.callData;
        if (
          typeof callData !== 'string' ||
          !callData.startsWith('0x') ||
          callData.length < 2 + 64
        ) {
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              ...baseResponse,
              note: 'userop_not_found_or_marker_absent',
            },
          });
        }

        const observedMarker = callData.slice(-64).toLowerCase();
        const verified = observedMarker === expectedMarker;

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            ...baseResponse,
            verified,
            observedMarker,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
