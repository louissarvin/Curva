// join_watch_party — read-only room lookup. Returns the pear:// deep link, host
// handle, host smart-account address, and match metadata so the caller can
// decide whether to tip, chat, or open a pool.
//
// Wraps GET /rooms/:slug on the Curva Companion. Read-only, no signing, no
// spend. Safe to call without elicitation.

import { z } from 'zod';
import { backendJson } from '../httpClient.js';
import { assertClean, logJson } from '../safety.js';

export function registerJoinWatchParty(server) {
  server.registerTool(
    'join_watch_party',
    {
      title: 'Join Curva watch party',
      description:
        'Look up a Curva room by slug. Returns the pear:// deep link, host handle, host wallet address, and the match the room is watching. Read-only.',
      inputSchema: {
        room_slug: z.string().min(1).max(64),
      },
      annotations: {
        title: 'Join Curva watch party',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      assertClean(args);
      const { room_slug } = args;

      let data;
      try {
        data = await backendJson(`/rooms/${encodeURIComponent(room_slug)}`);
      } catch (err) {
        logJson('error', 'join_watch_party.lookup_failed', {
          roomSlug: room_slug,
          message: err?.message,
        });
        throw err;
      }
      const room = data?.room;
      if (!room) throw new Error('ROOM_NOT_FOUND');

      const pearLink = room.pearLink || `pear://curva?room=${encodeURIComponent(room_slug)}`;
      const summary = [
        `Room: ${room.slug}`,
        `Host: ${room.hostHandle} (${room.hostSmartAddress})`,
        room.match?.homeTeam && room.match?.awayTeam
          ? `Match: ${room.match.homeTeam.code} vs ${room.match.awayTeam.code} (${room.match.stage || 'stage n/a'})`
          : null,
        room.match?.kickoffUtc ? `Kickoff: ${room.match.kickoffUtc}` : null,
        `Pear link: ${pearLink}`,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          slug: room.slug,
          matchId: room.matchId,
          hostHandle: room.hostHandle,
          hostSmartAddress: room.hostSmartAddress,
          hostOwnerAddress: room.hostOwnerAddress ?? null,
          pearLink,
          match: room.match ?? null,
        },
      };
    }
  );
}
