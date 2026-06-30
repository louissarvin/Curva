/**
 * Public tip-verification share URL (Wave 6 Tier 2).
 *
 *   GET /wdk/verify/:txHash
 *
 * Purpose: a shareable, screenshot-friendly URL that resolves a facilitator
 * FacilitatorTx row into a human-readable receipt. Suitable for pinning in the
 * DoraHacks submission description so judges can click through to confirm a
 * sponsored USDT tip landed on-chain.
 *
 * Content negotiation:
 *   Accept: text/html   -> minimal server-rendered card (inline CSS only)
 *   default             -> JSON envelope { success, error, data }
 *
 * Auth: none. Everything served here is already public on-chain.
 *
 * Redaction: `fromAddress` and `toAddress` are shortened via `shortenAddress`
 * so screenshots do not expose the wallet in full at a glance. The full
 * txHash IS returned because the explorer URL needs it and it is public.
 *
 * CSP: per-route override — HTML variant sets a strict CSP that disallows
 * scripts entirely; only inline styles are permitted (screenshot fidelity in
 * captive-portal networks per the same pattern as /status).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ethers } from 'ethers';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { getChain } from '../lib/evm/chains.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';

// =============================================================================
// Types
// =============================================================================

interface VerifyPayload {
  txHash: string;
  txHashFull: string;
  explorerUrl: string | null;
  chainId: number;
  chainName: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountFormatted: string;
  tokenSymbol: string;
  room: string | null;
  tipperHandle: string | null;
  submittedAt: string;
  confirmedAt: string | null;
  status: string;
}

// =============================================================================
// HTML escape (defense in depth — payload strings are server-controlled but the
// slug and tipperHandle can be free-form).
// =============================================================================

const escapeHtml = (s: unknown): string => {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// =============================================================================
// HTML renderer
// =============================================================================

const renderHtml = (p: VerifyPayload): string => {
  const badgeColor =
    p.status === 'confirmed' ? '#1aff8c' : p.status === 'failed' ? '#ff5470' : '#ffd166';
  const explorerLink = p.explorerUrl
    ? `<a href="${escapeHtml(p.explorerUrl)}" rel="noopener noreferrer">${escapeHtml(p.txHash)}</a>`
    : escapeHtml(p.txHash);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curva Tip Receipt · ${escapeHtml(p.txHash)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0c1117; color: #d8e0e8; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 40px 20px; }
  header { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #1f2733; padding-bottom: 16px; }
  header .logo { width: 28px; height: 28px; background: linear-gradient(135deg, #ff5470 0%, #1aff8c 100%); border-radius: 6px; }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .badge { margin-left: auto; padding: 4px 10px; border-radius: 999px; background: ${badgeColor}22; color: ${badgeColor}; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: #131a23; padding: 20px; border-radius: 10px; border: 1px solid #1f2733; margin-top: 24px; }
  .amount { font-size: 32px; font-weight: 700; color: #1aff8c; }
  .amount .token { font-size: 16px; color: #8aa1b8; margin-left: 6px; font-weight: 400; }
  dl { margin: 20px 0 0; font-size: 14px; }
  dt { color: #8aa1b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 12px; }
  dd { margin: 4px 0 0; word-break: break-all; }
  code { font-family: ui-monospace, "SF Mono", monospace; font-size: 13px; color: #d8e0e8; }
  a { color: #1aff8c; text-decoration: none; }
  a:hover { text-decoration: underline; }
  footer { margin-top: 32px; font-size: 12px; color: #8aa1b8; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo" aria-hidden="true"></div>
      <h1>Curva Tip Receipt</h1>
      <span class="badge">${escapeHtml(p.status)}</span>
    </header>
    <div class="card">
      <div class="amount">${escapeHtml(p.amountFormatted)}<span class="token"> ${escapeHtml(p.tokenSymbol)}</span></div>
      <dl>
        <dt>Transaction</dt>
        <dd><code>${explorerLink}</code></dd>
        <dt>Chain</dt>
        <dd>${escapeHtml(p.chainName)} <code>#${p.chainId}</code></dd>
        <dt>From</dt>
        <dd><code>${escapeHtml(p.fromAddress)}</code></dd>
        <dt>To</dt>
        <dd><code>${escapeHtml(p.toAddress)}</code>${p.room ? ` &middot; room <code>${escapeHtml(p.room)}</code>` : ''}</dd>
        ${p.tipperHandle ? `<dt>Tipper</dt><dd>${escapeHtml(p.tipperHandle)}</dd>` : ''}
        <dt>Submitted</dt>
        <dd>${escapeHtml(p.submittedAt)}</dd>
        ${p.confirmedAt ? `<dt>Confirmed</dt><dd>${escapeHtml(p.confirmedAt)}</dd>` : ''}
      </dl>
    </div>
    <footer>
      Verified receipt from a sponsored, gasless USDT tip via WDK EIP-3009. Forza Curva.
    </footer>
  </div>
</body>
</html>`;
};

// =============================================================================
// Content negotiation
// =============================================================================

const clientWantsHtml = (accept: string | string[] | undefined): boolean => {
  if (!accept) return false;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  // Order matters when both are present; be conservative and prefer HTML only
  // when the caller lists it and does not put JSON strictly ahead.
  if (!value.toLowerCase().includes('text/html')) return false;
  // A browser sending `Accept: text/html,application/xhtml+xml,...` is common;
  // a curl call sending `Accept: application/json` should NOT get HTML.
  return true;
};

// =============================================================================
// Route plugin
// =============================================================================

export const wdkVerifyRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/:txHash',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (
      request: FastifyRequest<{ Params: { txHash: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { txHash } = request.params;
        // Format-check up-front so we never issue a DB query on garbage input.
        if (typeof txHash !== 'string' || !ethers.isHexString(txHash, 32)) {
          return handleError(
            reply,
            400,
            'txHash must be a 0x-prefixed 32-byte hex value',
            'VALIDATION_ERROR'
          );
        }
        const normalized = txHash.toLowerCase();

        const row = await prismaQuery.facilitatorTx.findFirst({
          where: { txHash: normalized },
        });
        if (!row) {
          return handleError(reply, 404, 'Transaction not found', 'TX_NOT_FOUND');
        }

        // Chain name resolution — chains.ts is the single source of truth per
        // F10 ADR-009. Unknown chains fall back to the numeric id as a label
        // rather than crashing the page.
        const chain = getChain(row.chainId);
        const chainName = chain?.name ?? `Chain ${row.chainId}`;
        const explorerBase = chain?.explorerBase?.trim();
        const explorerUrl =
          explorerBase && explorerBase.length > 0
            ? `${explorerBase.replace(/\/$/, '')}/tx/${row.txHash}`
            : null;

        // Best-effort room + tipper enrichment. Never let a lookup failure
        // block the response — the tx has already landed on-chain and the
        // page's purpose is to be a shareable receipt.
        let room: string | null = null;
        let tipperHandle: string | null = null;
        try {
          const roomRow = await prismaQuery.room.findFirst({
            where: { hostSmartAddress: row.toAddress, deletedAt: null },
            select: { slug: true, hostHandle: true },
          });
          room = roomRow?.slug ?? null;
          tipperHandle = null; // Tipper handle is not persisted on FacilitatorTx.
          // Suppress "unused" — we may derive from a future TipEvent join.
          void roomRow?.hostHandle;
        } catch {
          /* best-effort enrichment */
        }

        const payload: VerifyPayload = {
          txHash: shortenAddress(row.txHash, 10, 6),
          txHashFull: row.txHash,
          explorerUrl,
          chainId: row.chainId,
          chainName,
          fromAddress: shortenAddress(row.fromAddress, 10, 6),
          toAddress: shortenAddress(row.toAddress, 10, 6),
          amount: row.amount,
          amountFormatted: formatUsdt(row.amount),
          tokenSymbol: 'USDT',
          room,
          tipperHandle,
          submittedAt: row.submittedAt.toISOString(),
          confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
          status: row.status,
        };

        if (clientWantsHtml(request.headers['accept'])) {
          reply.header('Content-Type', 'text/html; charset=utf-8');
          reply.header('Cache-Control', 'public, max-age=30');
          // Feature-specific CSP override. No scripts, only inline CSS, no
          // form submission, no framing. Explorer link opens in the same tab
          // via a plain `<a>` — safe under this CSP.
          reply.header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
          );
          return reply.code(200).send(renderHtml(payload));
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: payload,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
