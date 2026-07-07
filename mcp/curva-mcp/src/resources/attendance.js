// Template resource: curva://attendance/{slug}/{address}
//
// The verify endpoint requires signature+issuedAt+matchId as query params. A
// resource URI has no room to carry those safely, so we return a stub with a
// hint pointing the caller at the verify_attendance_pass tool. We never call
// the backend without params: it returns 400 and pollutes logs.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logJson } from '../safety.js';

const MIME = 'application/json';

export function registerAttendanceResource(server) {
  const template = new ResourceTemplate('curva://attendance/{slug}/{address}', {
    list: undefined,
  });

  server.registerResource(
    'curva_attendance',
    template,
    {
      title: 'Attendance pass verification',
      description:
        'Attendance pass verification stub. The verify endpoint requires signature, issuedAt, and matchId which cannot be carried in a resource URI. Call the verify_attendance_pass tool with those fields instead.',
      mimeType: MIME,
    },
    async (uri, { slug, address }) => {
      logJson('info', 'resource.read', { uri: uri.href, slug, address, kind: 'stub' });
      const stub = {
        slug,
        address,
        verified: null,
        hint: 'call verify_attendance_pass tool with slug, address, signature, issuedAt, matchId',
        endpoint: `/wdk/verify-attendance/${slug}/${address}`,
        requiredQuery: ['signature', 'issuedAt', 'matchId'],
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME,
            text: JSON.stringify(stub),
          },
        ],
      };
    },
  );
}
