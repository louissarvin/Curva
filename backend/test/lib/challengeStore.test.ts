import { describe, expect, test } from 'bun:test';
import { ChallengeStore } from '../../src/lib/challengeStore.ts';

describe('ChallengeStore', () => {
  test('issues unique high-entropy challenges', () => {
    const store = new ChallengeStore(300);
    const a = store.issue('room-a');
    const b = store.issue('room-b');
    expect(a.challenge).not.toBe(b.challenge);
    expect(a.challenge.length).toBeGreaterThanOrEqual(40);
    expect(a.expiresIn).toBe(300);
  });

  test('consume succeeds once then fails', () => {
    const store = new ChallengeStore(300);
    const { challenge } = store.issue('room-a');
    expect(store.consume('room-a', challenge)).toBe(true);
    expect(store.consume('room-a', challenge)).toBe(false);
  });

  test('consume rejects wrong challenge', () => {
    const store = new ChallengeStore(300);
    store.issue('room-a');
    expect(store.consume('room-a', 'not-the-right-one')).toBe(false);
  });

  test('consume rejects after expiry', async () => {
    const store = new ChallengeStore(0); // expires instantly
    const { challenge } = store.issue('room-a');
    await new Promise((r) => setTimeout(r, 10));
    expect(store.consume('room-a', challenge)).toBe(false);
  });

  test('re-issuing for the same key returns the existing unexpired challenge', () => {
    // Why: protects in-flight host signatures from being invalidated by an attacker
    // who spams /delete-challenge. See SECURITY_AUDIT.md CRIT-01a.
    const store = new ChallengeStore(300);
    const first = store.issue('room-a');
    const second = store.issue('room-a');
    expect(first.challenge).toBe(second.challenge);
    expect(store.consume('room-a', first.challenge)).toBe(true);
    // After consume, the next issue produces a fresh challenge.
    const third = store.issue('room-a');
    expect(third.challenge).not.toBe(first.challenge);
  });
});
