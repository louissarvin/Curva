// Fix Wave A T1 - parity test.
//
// Asserts the backend seeder's topic derivation for a given slug produces the
// same 32 bytes as the pear-app client derivation. If this test fails, the
// seeder and clients will land on different swarm topics and never discover
// each other. See:
//   - backend/seeder/topicForSlug.mjs
//   - pear-app/bare/topics.js
//
// This test dynamically imports hypercore-crypto and b4a. If those deps are not
// yet installed in backend/node_modules (they were added to package.json in
// Fix Wave A), the test skips with a clear message rather than false-passing.

import { describe, test, expect } from 'bun:test';

async function tryLoadDeps() {
  try {
    const crypto = (await import('hypercore-crypto')).default;
    const b4a = (await import('b4a')).default;
    return { crypto, b4a };
  } catch {
    return null;
  }
}

describe('seeder topic parity with pear-app', () => {
  test('backend topicForSlug matches pear-app topicForSlug for demo-match', async () => {
    const deps = await tryLoadDeps();
    if (!deps) {
      console.warn(
        '[topicParity] hypercore-crypto or b4a not installed. Run `bun install` in backend/ to enable this test.',
      );
      // Fail loudly, do NOT silently pass. Skipping would let a real regression
      // hide behind a missing dep.
      throw new Error('hypercore-crypto + b4a must be installed in backend/node_modules');
    }
    const { crypto, b4a } = deps;

    // The pear-app derivation is fixed in pear-app/bare/topics.js:94:
    //   crypto.data(b4a.from('curva/' + slug))
    const slug = 'demo-match';
    const pearAppTopic: Buffer = crypto.data(b4a.from('curva/' + slug));

    // The backend derivation lives in backend/seeder/topicForSlug.mjs.
    const { topicForSlug } = await import('../../seeder/topicForSlug.mjs');
    const backendTopic: Buffer = topicForSlug(slug);

    expect(backendTopic.length).toBe(32);
    expect(pearAppTopic.length).toBe(32);
    expect(b4a.toString(backendTopic, 'hex')).toBe(b4a.toString(pearAppTopic, 'hex'));
  });

  test('backend topicForSlug rejects empty and oversized slugs', async () => {
    const deps = await tryLoadDeps();
    if (!deps) return; // dep-check enforced by the parity test above
    const { topicForSlug } = await import('../../seeder/topicForSlug.mjs');
    expect(() => topicForSlug('')).toThrow();
    expect(() => topicForSlug('x'.repeat(65))).toThrow();
    expect(() => topicForSlug(123 as unknown as string)).toThrow();
  });

  test('backend topicForSlug is deterministic across slugs', async () => {
    const deps = await tryLoadDeps();
    if (!deps) return;
    const { topicForSlug } = await import('../../seeder/topicForSlug.mjs');
    const a = topicForSlug('demo-match');
    const b = topicForSlug('demo-match');
    const c = topicForSlug('demo-match-2');
    const { b4a } = deps;
    expect(b4a.toString(a, 'hex')).toBe(b4a.toString(b, 'hex'));
    expect(b4a.toString(a, 'hex')).not.toBe(b4a.toString(c, 'hex'));
  });
});
