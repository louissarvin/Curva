// Canonical Curva topic derivation - MUST match pear-app/bare/topics.js.
//
// Pear clients derive their swarm topic via hypercore-crypto.data(b4a.from('curva/' + slug)),
// which is BLAKE2b-256 with a LEAF-type prefix (per hypercore-crypto/index.js:82-88).
// The backend seeder MUST use the exact same derivation or it will land on a
// different topic and never discover peers.
//
// DO NOT swap this out for createHash('sha256'). That is what the pre-Fix-Wave-A
// seeder did, and it produced a topic drift that made seeder-vs-client discovery
// impossible.
//
// hypercore-crypto and b4a MUST be installed in backend/node_modules. See
// backend/package.json dependencies.

import crypto from 'hypercore-crypto';
import b4a from 'b4a';

export const TOPIC_PREFIX = 'curva/';

/**
 * @param {string} slug room slug (ASCII, 1-64 chars)
 * @returns {Buffer} 32-byte topic hash for hyperswarm.join()
 */
export function topicForSlug(slug) {
  if (typeof slug !== 'string') {
    throw new TypeError('slug must be a string');
  }
  if (slug.length === 0 || slug.length > 64) {
    throw new RangeError('slug must be 1-64 characters');
  }
  return crypto.data(b4a.from(TOPIC_PREFIX + slug));
}
