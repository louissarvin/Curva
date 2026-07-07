// Template resource: curva://rooms/{slug}/roster
//
// Prefers GET /rooms/:slug/roster. Falls back to projecting the writer/reader
// arrays out of GET /rooms/:slug when the roster endpoint returns non-2xx.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerRoomRosterResource(server) {
  const template = new ResourceTemplate('curva://rooms/{slug}/roster', {
    // No enumeration: roster is a projection of a room, discovery happens via
    // curva://rooms and curva://rooms/{slug}.
    list: undefined,
  });

  server.registerResource(
    'curva_room_roster',
    template,
    {
      title: 'Curva room roster',
      description:
        'Writers and readers of a room. Falls back to projecting roster from /rooms/:slug when the dedicated roster endpoint is not available.',
      mimeType: MIME,
    },
    async (uri, { slug }) => {
      const encoded = encodeURIComponent(slug);
      let data;
      let source = 'roster_endpoint';
      try {
        data = await backendJson(`/rooms/${encoded}/roster`);
      } catch (rosterErr) {
        try {
          const room = await backendJson(`/rooms/${encoded}`);
          data = {
            writers: Array.isArray(room?.writers) ? room.writers : [],
            readers: Array.isArray(room?.readers) ? room.readers : [],
          };
          source = 'projected_from_room';
        } catch (fallbackErr) {
          const message = fallbackErr?.message?.slice(0, 200) || 'unknown';
          logJson('warn', 'resource.read_failed', {
            uri: uri.href,
            slug,
            error: message,
            rosterError: rosterErr?.message?.slice(0, 200),
          });
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: MIME,
                text: JSON.stringify({ error: message, note: 'backend_unreachable' }),
              },
            ],
          };
        }
      }
      logJson('info', 'resource.read', { uri: uri.href, slug, source });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME,
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );
}
