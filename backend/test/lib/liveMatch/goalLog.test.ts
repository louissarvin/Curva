/**
 * F7 unit tests for the in-memory goal log used by /matches/:id/live.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  __sizeForTest,
  append,
  get,
  reset,
  type GoalLogEntry,
} from '../../../src/lib/liveMatch/goalLog.ts';

const mkEntry = (overrides: Partial<GoalLogEntry> = {}): GoalLogEntry => ({
  minute: 23,
  team: 'home',
  scorer: 'Vinicius Junior',
  homeScoreAfter: 1,
  awayScoreAfter: 0,
  observedAt: Date.now(),
  ...overrides,
});

describe('goalLog', () => {
  afterEach(() => reset());

  test('append and get round-trip', () => {
    append('m1', mkEntry());
    const out = get('m1');
    expect(out.length).toBe(1);
    expect(out[0]!.scorer).toBe('Vinicius Junior');
  });

  test('returns a copy — mutating the returned array does not leak', () => {
    append('m1', mkEntry());
    const out = get('m1');
    out.push(mkEntry({ team: 'away' }));
    expect(get('m1').length).toBe(1);
  });

  test('empty array for unknown match', () => {
    expect(get('nope')).toEqual([]);
  });

  test('caps entries at 20 per match (oldest dropped first)', () => {
    for (let i = 0; i < 25; i++) {
      append('m1', mkEntry({ minute: i, scorer: `s${i}`, observedAt: i }));
    }
    const out = get('m1');
    expect(out.length).toBe(20);
    // First entry should be minute=5 because entries 0..4 were evicted.
    expect(out[0]!.minute).toBe(5);
    expect(out[out.length - 1]!.minute).toBe(24);
  });

  test('LRU eviction at 200 matches', () => {
    // Fill to the cap.
    for (let i = 0; i < 200; i++) {
      append(`m${i}`, mkEntry({ observedAt: i + 1 }));
    }
    expect(__sizeForTest()).toBe(200);

    // Adding a 201st match evicts the oldest (m0, observedAt = 1).
    append('m200', mkEntry({ observedAt: 1000 }));
    expect(__sizeForTest()).toBe(200);
    expect(get('m0')).toEqual([]);
    expect(get('m200').length).toBe(1);
  });

  test('reset clears state', () => {
    append('m1', mkEntry());
    expect(__sizeForTest()).toBe(1);
    reset();
    expect(__sizeForTest()).toBe(0);
    expect(get('m1')).toEqual([]);
  });

  test('ignores empty matchId', () => {
    append('', mkEntry());
    expect(__sizeForTest()).toBe(0);
  });
});
