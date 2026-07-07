// Static resource: enumerates public Curva watch-party rooms.
//
// registerResource(name, uri: string, config, ReadResourceCallback) overload
// verified against @modelcontextprotocol/sdk mcp.d.ts line 102.

import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerRoomsListResource(server) {
  server.registerResource(
    'curva_rooms',
    'curva://rooms',
    {
      title: 'Public Curva rooms',
      description:
        'List of public Curva watch-party rooms currently hosted on the Companion. Returns slug, host handle, matchId, peerCount, visibility.',
      mimeType: MIME,
    },
    async (uri) => {
      try {
        const data = await backendJson('/rooms', { query: { visibility: 'public' } });
        logJson('info', 'resource.read', {
          uri: uri.href,
          count: Array.isArray(data) ? data.length : 0,
        });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME,
              text: JSON.stringify(data ?? []),
            },
          ],
        };
      } catch (err) {
        const message = err?.message?.slice(0, 200) || 'unknown';
        logJson('warn', 'resource.read_failed', { uri: uri.href, error: message });
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
    },
  );
}
