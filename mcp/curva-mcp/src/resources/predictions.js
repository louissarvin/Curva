// Template resource: curva://predictions/{poolId}
//
// No list callback in phase 1; pool discovery happens via the room detail
// (which carries the pool id) and via prior submit_prediction responses.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerPredictionsResource(server) {
  const template = new ResourceTemplate('curva://predictions/{poolId}', {
    list: undefined,
  });

  server.registerResource(
    'curva_prediction_pool',
    template,
    {
      title: 'Prediction pool state',
      description:
        'Current state of a prediction pool: options, stake totals, per-option pot, resolution status, matchId binding.',
      mimeType: MIME,
    },
    async (uri, { poolId }) => {
      try {
        const data = await backendJson(`/predictions/pool/${encodeURIComponent(poolId)}`);
        logJson('info', 'resource.read', { uri: uri.href, poolId });
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
        logJson('warn', 'resource.read_failed', { uri: uri.href, poolId, error: message });
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
