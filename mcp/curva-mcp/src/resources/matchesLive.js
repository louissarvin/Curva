// Static resource: enumerates today's live 2026 World Cup fixtures.
//
// Backend exposes /matches/today; we surface it as curva://matches/live so the
// MCP URI stays stable across day boundaries.

import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerMatchesLiveResource(server) {
  server.registerResource(
    'curva_matches_live',
    'curva://matches/live',
    {
      title: 'Live matches today',
      description:
        'Today\'s 2026 World Cup fixtures relevant to Curva watch parties. Returns matchId, teams, kickoff, status, score.',
      mimeType: MIME,
    },
    async (uri) => {
      try {
        const data = await backendJson('/matches/today');
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
