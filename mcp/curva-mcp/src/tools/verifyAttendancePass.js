// verify_attendance_pass — pure read. Verifies a signed attendance pass via the
// Companion. Anyone can call this; no wallet touch needed.
//
// GET /wdk/verify-attendance/:slug/:address
//   ?signature=<sig>&issuedAt=<unix-seconds>&matchId=<opt>
//
// Companion returns { valid, hostAddress, hostAddressShort, ageSeconds,
// ageHours, registered } on 200, or { error: 'PASS_EXPIRED' } on 410 after the
// 24h window.

import { z } from 'zod';
import { backendRequest } from '../httpClient.js';
import { assertClean } from '../safety.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130,132}$/;

export function registerVerifyAttendancePass(server) {
  server.registerTool(
    'verify_attendance_pass',
    {
      title: 'Verify attendance pass',
      description:
        'Verify a Curva attendance pass signed by a room host. Read-only lookup via the Curva Companion. Returns { valid, hostAddress, ageSeconds, registered }.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
        peer_address: z.string().regex(ADDR_RE),
        signature: z.string().regex(SIG_RE),
        issued_at: z.number().int().positive(),
        match_id: z.string().min(1).max(64).optional(),
      },
      annotations: {
        title: 'Verify attendance pass',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { room_slug, peer_address, signature, issued_at, match_id } = args;
      const peerLower = peer_address.toLowerCase();
      const path = `/wdk/verify-attendance/${encodeURIComponent(room_slug)}/${peerLower}`;
      const query = {
        signature,
        issuedAt: issued_at,
      };
      if (match_id) query.matchId = match_id;

      const { status, payload } = await backendRequest(path, {
        method: 'GET',
        query,
      });

      if (status === 200 && payload?.success !== false) {
        const data = payload?.data ?? payload;
        const text = [
          `Attendance pass: VALID`,
          `Host: ${data.hostAddressShort || data.hostAddress}`,
          typeof data.ageSeconds === 'number'
            ? `Age: ${data.ageSeconds}s (${(data.ageHours ?? data.ageSeconds / 3600).toFixed?.(2)}h)`
            : null,
          `Registered in Companion: ${data.registered ? 'yes' : 'no'}`,
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { valid: true, ...data },
        };
      }

      // Non-200 or explicit failure. Never throw for verify calls — the caller
      // needs the structured status so they can render a proper "invalid" state.
      const errCode = payload?.error?.code || 'INVALID';
      const errMsg = payload?.error?.message || `HTTP ${status}`;
      return {
        content: [
          {
            type: 'text',
            text: `Attendance pass: INVALID (${errCode}) — ${errMsg}`,
          },
        ],
        structuredContent: {
          valid: false,
          status,
          errorCode: errCode,
          errorMessage: errMsg,
        },
      };
    }
  );
}
