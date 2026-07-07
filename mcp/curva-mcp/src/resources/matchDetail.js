// Template resource: curva://matches/{matchId}
//
// list callback reuses /matches/today so clients discover the day's fixtures.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerMatchDetailResource(server) {
  const template = new ResourceTemplate('curva://matches/{matchId}', {
    list: async () => {
      try {
        const matches = await backendJson('/matches/today');
        return {
          resources: (matches ?? []).map((m) => {
            const id = m.matchId ?? m.id;
            const home = m.homeTeam?.name ?? m.homeTeam ?? 'Home';
            const away = m.awayTeam?.name ?? m.awayTeam ?? 'Away';
            return {
              uri: `curva://matches/${id}`,
              name: `curva_match_${id}`,
              title: `${home} vs ${away}`,
              mimeType: MIME,
            };
          }),
        };
      } catch (err) {
        logJson('warn', 'resource.list_failed', {
          uri: 'curva://matches/{matchId}',
          error: err?.message?.slice(0, 200),
        });
        return { resources: [] };
      }
    },
    complete: {
      matchId: async (partial) => {
        try {
          const matches = await backendJson('/matches/today');
          return (matches ?? [])
            .map((m) => String(m.matchId ?? m.id ?? ''))
            .filter((id) => id && id.startsWith(partial));
        } catch {
          return [];
        }
      },
    },
  });

  server.registerResource(
    'curva_match',
    template,
    {
      title: 'Match detail',
      description:
        'Full state of a single fixture by matchId: teams, kickoff, status, score, goal log if in progress.',
      mimeType: MIME,
    },
    async (uri, { matchId }) => {
      try {
        const data = await backendJson(`/matches/${encodeURIComponent(matchId)}`);
        logJson('info', 'resource.read', { uri: uri.href, matchId });
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
        logJson('warn', 'resource.read_failed', { uri: uri.href, matchId, error: message });
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
