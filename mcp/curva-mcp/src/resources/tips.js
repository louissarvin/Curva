// Template resource: curva://tips/{address}
//
// No list callback: address space is unbounded and enumeration is meaningless.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { backendJson } from '../httpClient.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerTipsResource(server) {
  const template = new ResourceTemplate('curva://tips/{address}', {
    list: undefined,
  });

  server.registerResource(
    'curva_tips',
    template,
    {
      title: 'Tips received by address',
      description:
        'Tip history for a given EVM address (host or user). Returns amounts, from, txHash, matchId, roomSlug.',
      mimeType: MIME,
    },
    async (uri, { address }) => {
      try {
        const data = await backendJson(`/tips/${encodeURIComponent(address)}`);
        logJson('info', 'resource.read', { uri: uri.href, address });
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
        logJson('warn', 'resource.read_failed', { uri: uri.href, address, error: message });
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
