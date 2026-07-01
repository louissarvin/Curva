/**
 * F11 confirmation worker unit tests.
 *
 * We mock prisma + the ethers provider withProviderForChain so the worker's
 * tick runs deterministically without touching an RPC or the DB.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

// -----------------------------------------------------------------------------
// Prisma stub
// -----------------------------------------------------------------------------

interface FakeFacTx {
  id: string;
  chainId: number;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  status: string;
  submittedAt: Date;
  confirmedAt: Date | null;
  confirmedBlock: number | null;
  errorMessage: string | null;
}

const rows: FakeFacTx[] = [];

const fakePrisma = {
  facilitatorTx: {
    findMany: async (args: {
      where: { status: string; submittedAt: { lt: Date } };
      take?: number;
      orderBy?: unknown;
      select?: unknown;
    }) => {
      const cutoff = args.where.submittedAt.lt.getTime();
      return rows
        .filter((r) => r.status === args.where.status && r.submittedAt.getTime() < cutoff)
        .slice(0, args.take ?? rows.length);
    },
    update: async (args: { where: { id: string }; data: Partial<FakeFacTx> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
  },
  room: {
    findFirst: async () => null,
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// -----------------------------------------------------------------------------
// Provider stub — returns a receipt map keyed by tx hash.
// -----------------------------------------------------------------------------

interface FakeReceipt {
  status: number;
  blockNumber: number;
}

const receipts = new Map<string, FakeReceipt | null>();

const providerStub = {
  getTransactionReceipt: async (txHash: string) => {
    const r = receipts.get(txHash);
    if (r === undefined) return null;
    return r;
  },
  getBalance: async () => 10n ** 18n, // 1 ETH
};

const providerModule = await import('../../src/lib/evm/provider.ts');
mock.module('../../src/lib/evm/provider.ts', () => ({
  ...providerModule,
  withProviderForChain: async <T>(_chain: unknown, op: (p: unknown) => Promise<T>) => op(providerStub),
}));

// -----------------------------------------------------------------------------
// Inject a stub sponsor to enable the facilitator.
// -----------------------------------------------------------------------------

const facilitatorModule = await import('../../src/lib/evm/facilitator.ts');
const { __setSponsorForTest, __resetBalanceCacheForTest } = facilitatorModule;

// -----------------------------------------------------------------------------
// Subscribe to the real eventBus (matching the pattern used in Wave 3 tests).
// -----------------------------------------------------------------------------

import { eventBus } from '../../src/lib/activity/eventBus.ts';

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

const captured: Captured[] = [];
let unsubscribe: (() => void) | null = null;

// -----------------------------------------------------------------------------
// Import worker AFTER all mocks in place.
// -----------------------------------------------------------------------------

const { __tickForTest, __resetForTest } = await import('../../src/workers/relayConfirmationWorker.ts');

beforeAll(() => {
  __setSponsorForTest(new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32))));
  eventBus.__resetForTest();
  unsubscribe = eventBus.subscribe((ev) => {
    captured.push({ type: ev.type, payload: ev.payload as Record<string, unknown> });
  });
});

afterAll(() => {
  if (unsubscribe) unsubscribe();
  __setSponsorForTest(null);
  __resetBalanceCacheForTest();
  __resetForTest();
});

describe('relayConfirmationWorker tick', () => {
  test('receipt with status=1 updates row to confirmed and publishes facilitator.confirmed', async () => {
    rows.length = 0;
    captured.length = 0;
    receipts.clear();

    const txHash = '0x' + '11'.repeat(32);
    rows.push({
      id: 'row-1',
      chainId: 11155111,
      txHash,
      fromAddress: '0x' + '22'.repeat(20),
      toAddress: '0x' + '33'.repeat(20),
      amount: '1000000',
      status: 'submitted',
      submittedAt: new Date(Date.now() - 30_000),
      confirmedAt: null,
      confirmedBlock: null,
      errorMessage: null,
    });
    receipts.set(txHash, { status: 1, blockNumber: 123456 });

    await __tickForTest();

    const updated = rows[0];
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('confirmed');
    expect(updated!.confirmedBlock).toBe(123456);
    expect(captured.some((e) => e.type === 'facilitator.confirmed')).toBe(true);
  });

  test('receipt with status=0 updates row to failed', async () => {
    rows.length = 0;
    captured.length = 0;
    receipts.clear();

    const txHash = '0x' + '44'.repeat(32);
    rows.push({
      id: 'row-2',
      chainId: 11155111,
      txHash,
      fromAddress: '0x' + '55'.repeat(20),
      toAddress: '0x' + '66'.repeat(20),
      amount: '1000000',
      status: 'submitted',
      submittedAt: new Date(Date.now() - 30_000),
      confirmedAt: null,
      confirmedBlock: null,
      errorMessage: null,
    });
    receipts.set(txHash, { status: 0, blockNumber: 234567 });

    await __tickForTest();

    const updated = rows[0];
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('failed');
    expect(updated!.errorMessage).toBe('transaction reverted');
    expect(captured.some((e) => e.type === 'facilitator.failed')).toBe(true);
  });

  test('receipt=null within timeout leaves row as submitted', async () => {
    rows.length = 0;
    captured.length = 0;
    receipts.clear();

    const txHash = '0x' + '77'.repeat(32);
    rows.push({
      id: 'row-3',
      chainId: 11155111,
      txHash,
      fromAddress: '0x' + '88'.repeat(20),
      toAddress: '0x' + '99'.repeat(20),
      amount: '1000000',
      status: 'submitted',
      submittedAt: new Date(Date.now() - 30_000),
      confirmedAt: null,
      confirmedBlock: null,
      errorMessage: null,
    });
    // Set to null (undefined would be treated as unknown).
    receipts.set(txHash, null);

    await __tickForTest();

    const updated = rows[0];
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('submitted');
  });

  test('receipt=null past timeout window marks row failed with timeout message', async () => {
    rows.length = 0;
    captured.length = 0;
    receipts.clear();

    const txHash = '0x' + 'aa'.repeat(32);
    // RELAY_CONFIRMATION_TIMEOUT_MIN defaults to 5, so 6 minutes ago is stale.
    rows.push({
      id: 'row-4',
      chainId: 11155111,
      txHash,
      fromAddress: '0x' + 'bb'.repeat(20),
      toAddress: '0x' + 'cc'.repeat(20),
      amount: '1000000',
      status: 'submitted',
      submittedAt: new Date(Date.now() - 6 * 60_000),
      confirmedAt: null,
      confirmedBlock: null,
      errorMessage: null,
    });
    receipts.set(txHash, null);

    await __tickForTest();

    const updated = rows[0];
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('failed');
    expect(updated!.errorMessage).toBe('confirmation timeout');
  });

  test('rows submitted within 10s buffer are skipped', async () => {
    rows.length = 0;
    captured.length = 0;
    receipts.clear();

    const txHash = '0x' + 'dd'.repeat(32);
    rows.push({
      id: 'row-5',
      chainId: 11155111,
      txHash,
      fromAddress: '0x' + 'ee'.repeat(20),
      toAddress: '0x' + 'ff'.repeat(20),
      amount: '1000000',
      status: 'submitted',
      submittedAt: new Date(Date.now() - 1_000), // 1s ago
      confirmedAt: null,
      confirmedBlock: null,
      errorMessage: null,
    });
    receipts.set(txHash, { status: 1, blockNumber: 999 });

    await __tickForTest();

    const updated = rows[0];
    expect(updated).toBeDefined();
    // Should still be submitted because the buffer excluded it.
    expect(updated!.status).toBe('submitted');
  });
});
