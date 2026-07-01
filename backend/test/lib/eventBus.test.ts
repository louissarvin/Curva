/**
 * F1 unit tests for the in-process event bus / SSE broker.
 */

import { describe, expect, test } from 'bun:test';
import { EventBus } from '../../src/lib/activity/eventBus.ts';

describe('EventBus', () => {
  test('publishes and fans out to subscribers matching topic', () => {
    const bus = new EventBus(100, 10);
    const received: string[] = [];
    const unsub = bus.subscribe((ev) => received.push(ev.type), { topics: new Set(['tips']) });
    if (!unsub) throw new Error('subscribe failed');

    bus.publish('tip.confirmed', {
      txHash: '0xabc',
      fromAddress: '0xa..b',
      toAddress: '0xc..d',
      amount: '1000000',
      amountFormatted: '1.000000',
      blockNumber: 1,
      blockTime: new Date().toISOString(),
      roomSlug: null,
    });
    bus.publish('room.created', { slug: 's', matchId: 'm', hostHandle: 'h', isAutoWarmed: false });

    expect(received).toEqual(['tip.confirmed']);
    unsub();
  });

  test('ring buffer trims to capacity', () => {
    const bus = new EventBus(3, 10);
    for (let i = 0; i < 5; i++) {
      bus.publish('room.created', { slug: `s${i}`, matchId: 'm', hostHandle: 'h', isAutoWarmed: false });
    }
    const recent = bus.getRecent({});
    expect(recent.length).toBe(3);
  });

  test('getHistorySince replays only events after the cursor', () => {
    const bus = new EventBus(100, 10);
    const e1 = bus.publish('room.created', { slug: 'a', matchId: 'm', hostHandle: 'h', isAutoWarmed: false });
    bus.publish('room.created', { slug: 'b', matchId: 'm', hostHandle: 'h', isAutoWarmed: false });
    bus.publish('room.created', { slug: 'c', matchId: 'm', hostHandle: 'h', isAutoWarmed: false });

    const after = bus.getHistorySince(e1.id);
    expect(after.length).toBe(2);
    expect((after[0]!.payload as { slug: string }).slug).toBe('b');
  });

  test('subscribe returns null when over the connection cap', () => {
    const bus = new EventBus(10, 1);
    const u1 = bus.subscribe(() => {});
    const u2 = bus.subscribe(() => {});
    expect(u1).not.toBeNull();
    expect(u2).toBeNull();
    u1?.();
  });

  test('topic filter excludes unwanted events', () => {
    const bus = new EventBus(10, 10);
    const got: string[] = [];
    const unsub = bus.subscribe((ev) => got.push(ev.topic), {
      topics: new Set(['rooms']),
    });
    if (!unsub) throw new Error('subscribe failed');
    bus.publish('tip.confirmed', {
      txHash: 'x',
      fromAddress: '',
      toAddress: '',
      amount: '0',
      amountFormatted: '0',
      blockNumber: 0,
      blockTime: new Date().toISOString(),
      roomSlug: null,
    });
    bus.publish('room.created', { slug: 's', matchId: 'm', hostHandle: 'h', isAutoWarmed: false });
    expect(got).toEqual(['rooms']);
    unsub();
  });

  // ===========================================================================
  // Wave 3 (Section 20): five new match.* event types, all topic = 'matches'.
  // ===========================================================================

  test('publishes match.kickoff under topic "matches"', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.kickoff', {
      matchId: 'm1',
      homeTeam: 'Argentina',
      awayTeam: 'Brazil',
      kickoffUtc: new Date().toISOString(),
    });
    expect(ev.topic).toBe('matches');
    expect(ev.type).toBe('match.kickoff');
  });

  test('publishes match.goal with scorer + minute payload', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.goal', {
      matchId: 'm1',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: 'Messi',
      minute: 17,
    });
    expect(ev.topic).toBe('matches');
    expect((ev.payload as { scorer: string | null }).scorer).toBe('Messi');
  });

  test('match.goal accepts null scorer + minute (free-tier upstream)', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.goal', {
      matchId: 'm1',
      team: 'away',
      newScore: { home: 1, away: 1 },
      scorer: null,
      minute: null,
    });
    const p = ev.payload as { scorer: string | null; minute: number | null };
    expect(p.scorer).toBeNull();
    expect(p.minute).toBeNull();
  });

  test('publishes match.score_changed under topic "matches"', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.score_changed', {
      matchId: 'm1',
      previous: { home: 0, away: 0 },
      current: { home: 1, away: 0 },
    });
    expect(ev.topic).toBe('matches');
    expect(ev.type).toBe('match.score_changed');
  });

  test('publishes match.halftime under topic "matches"', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.halftime', {
      matchId: 'm1',
      score: { home: 1, away: 0 },
    });
    expect(ev.topic).toBe('matches');
    expect(ev.type).toBe('match.halftime');
  });

  test('publishes match.fulltime under topic "matches"', () => {
    const bus = new EventBus(10, 10);
    const ev = bus.publish('match.fulltime', {
      matchId: 'm1',
      score: { home: 2, away: 1 },
    });
    expect(ev.topic).toBe('matches');
    expect(ev.type).toBe('match.fulltime');
  });

  test('all match.* events reach a topic=matches subscriber in one fanout pass', () => {
    const bus = new EventBus(100, 10);
    const got: string[] = [];
    const unsub = bus.subscribe((ev) => got.push(ev.type), {
      topics: new Set(['matches']),
    });
    if (!unsub) throw new Error('subscribe failed');

    bus.publish('match.kickoff', {
      matchId: 'm1',
      homeTeam: 'A',
      awayTeam: 'B',
      kickoffUtc: new Date().toISOString(),
    });
    bus.publish('match.goal', {
      matchId: 'm1',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: null,
      minute: 10,
    });
    bus.publish('match.score_changed', {
      matchId: 'm1',
      previous: { home: 0, away: 0 },
      current: { home: 1, away: 0 },
    });
    bus.publish('match.halftime', { matchId: 'm1', score: { home: 1, away: 0 } });
    bus.publish('match.fulltime', { matchId: 'm1', score: { home: 2, away: 1 } });

    expect(got).toEqual([
      'match.kickoff',
      'match.goal',
      'match.score_changed',
      'match.halftime',
      'match.fulltime',
    ]);
    unsub();
  });

  test('TipConfirmedPayload accepts chainId + chainName (F10 readiness)', () => {
    const bus = new EventBus(10, 10);
    const withChain = bus.publish('tip.confirmed', {
      txHash: '0xabc',
      fromAddress: '0xa..b',
      toAddress: '0xc..d',
      amount: '1000000',
      amountFormatted: '1.000000',
      blockNumber: 1,
      blockTime: new Date().toISOString(),
      roomSlug: null,
      chainId: 11155111,
      chainName: 'Sepolia',
    });
    const p = withChain.payload as { chainId?: number; chainName?: string };
    expect(p.chainId).toBe(11155111);
    expect(p.chainName).toBe('Sepolia');
  });

  test('TipConfirmedPayload is valid without chainId + chainName (backward-compatible)', () => {
    const bus = new EventBus(10, 10);
    const noChain = bus.publish('tip.confirmed', {
      txHash: '0xabc',
      fromAddress: '0xa..b',
      toAddress: '0xc..d',
      amount: '1000000',
      amountFormatted: '1.000000',
      blockNumber: 1,
      blockTime: new Date().toISOString(),
      roomSlug: null,
    });
    const p = noChain.payload as { chainId?: number; chainName?: string };
    expect(p.chainId).toBeUndefined();
    expect(p.chainName).toBeUndefined();
  });
});
