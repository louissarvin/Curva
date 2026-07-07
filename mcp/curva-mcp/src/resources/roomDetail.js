// Template resource: curva://rooms/{slug}
//
// ResourceTemplate constructor signature per mcp.d.ts line 225:
//   new ResourceTemplate(uriTemplate, { list, complete? })
// list is REQUIRED (can be undefined) so we do not silently drop enumeration.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerRoomDetailResource(server) {
  const template = new ResourceTemplate('curva://rooms/{slug}', {
    // Reuse the public room list so a client can discover valid {slug} values.
    list: async () => {
      try {
        const rooms = await backendJson('/rooms', { query: { visibility: 'public' } });
        return {
          resources: (rooms ?? []).map((r) => ({
            uri: `curva://rooms/${r.slug}`,
            name: `curva_room_${r.slug}`,
            title: r.hostHandle ? `Room ${r.slug} (host ${r.hostHandle})` : `Room ${r.slug}`,
            mimeType: MIME,
          })),
        };
      } catch (err) {
        logJson('warn', 'resource.list_failed', {
          uri: 'curva://rooms/{slug}',
          error: err?.message?.slice(0, 200),
        });
        return { resources: [] };
      }
    },
    complete: {
      slug: async (partial) => {
        try {
          const rooms = await backendJson('/rooms', { query: { visibility: 'public' } });
          return (rooms ?? [])
            .map((r) => r.slug)
            .filter((s) => typeof s === 'string' && s.startsWith(partial));
        } catch {
          return [];
        }
      },
    },
  });

  server.registerResource(
    'curva_room',
    template,
    {
      title: 'Curva room detail',
      description:
        'Full state of a single Curva room by slug: host, match binding, peer count, visibility, tipsAddress.',
      mimeType: MIME,
    },
    async (uri, { slug }) => {
      try {
        const data = await backendJson(`/rooms/${encodeURIComponent(slug)}`);
        logJson('info', 'resource.read', { uri: uri.href, slug });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME,
              text: JSON.stringify(data ?? null),
            },
          ],
        };
      } catch (err) {
        const message = err?.message?.slice(0, 200) || 'unknown';
        logJson('warn', 'resource.read_failed', { uri: uri.href, slug, error: message });
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
