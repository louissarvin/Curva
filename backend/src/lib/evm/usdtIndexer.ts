import { ethers } from 'ethers';
import { prismaQuery } from '../prisma.ts';
import { noteLastBlock, withProviderForChain } from './provider.ts';
import type { ChainConfig } from './chains.ts';
import { eventBus } from '../activity/eventBus.ts';
import { shortenAddress } from '../../utils/miscUtils.ts';

const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const CHUNK_SIZE = 25; // up to 25 addresses per queryFilter call

/**
 * Resolve cursor for (chainId, tokenAddress). Bootstrap to
 * `currentBlock - bootstrapBackfillBlocks` the first time we see this token, so
 * we don't replay the entire chain history.
 */
export const getOrInitCursor = async (
  chainId: number,
  tokenAddress: string,
  currentBlock: number,
  bootstrapBackfill: number
): Promise<number> => {
  const existing = await prismaQuery.indexerCursor.findUnique({
    where: { chainId_tokenAddress: { chainId, tokenAddress } },
  });
  if (existing) return existing.lastBlockNumber;

  const bootstrap = Math.max(0, currentBlock - bootstrapBackfill);
  await prismaQuery.indexerCursor.create({
    data: { chainId, tokenAddress, lastBlockNumber: bootstrap },
  });
  return bootstrap;
};

export const updateCursor = async (
  chainId: number,
  tokenAddress: string,
  lastBlockNumber: number
): Promise<void> => {
  await prismaQuery.indexerCursor.update({
    where: { chainId_tokenAddress: { chainId, tokenAddress } },
    data: { lastBlockNumber },
  });
};

/**
 * Get the distinct set of host addresses we need to index. Lowercase.
 */
export const getRegisteredHostAddresses = async (): Promise<string[]> => {
  const rows = await prismaQuery.room.findMany({
    where: { deletedAt: null },
    select: { hostSmartAddress: true },
    distinct: ['hostSmartAddress'],
  });
  return rows.map((r) => r.hostSmartAddress.toLowerCase());
};

/**
 * Look up the most-recent active room for a given host address.
 * Returns roomId or null.
 *
 * NOTE: A single host address may own multiple rooms over time. We bind a tip
 * event to the *most recent* active room. If no room is currently active, the
 * tip is stored with roomId = null (still queryable via /tips/:address).
 */
const resolveRoomIdForAddress = async (
  addressLower: string,
  byAddressCache: Map<string, string | null>
): Promise<string | null> => {
  if (byAddressCache.has(addressLower)) return byAddressCache.get(addressLower) ?? null;
  const room = await prismaQuery.room.findFirst({
    where: { hostSmartAddress: addressLower, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const id = room?.id ?? null;
  byAddressCache.set(addressLower, id);
  return id;
};

/**
 * Single scan pass for one chain. Idempotent: re-running with the same cursor
 * produces the same DB state because we upsert on (txHash, logIndex).
 */
export interface ScanResult {
  chainId: number;
  scannedFrom: number;
  scannedTo: number;
  hostCount: number;
  eventCount: number;
  insertedCount: number;
}

export const runIndexerScan = async (chain: ChainConfig): Promise<ScanResult | null> => {
  if (chain.usdtAddress.length === 0) {
    // Defensive: getEnabledChains() filters this out, but a caller passing a
    // misconfigured chain must not crash the worker.
    console.warn(
      `[UsdtIndexer][chain=${chain.chainId}][${chain.name}] usdtAddress empty; skipping`
    );
    return null;
  }
  const tokenAddress = chain.usdtAddress;
  const chainId = chain.chainId;

  // 1. Determine block range.
  const currentBlock = await withProviderForChain(chain, (p) => p.getBlockNumber());
  noteLastBlock(chainId, currentBlock);
  const safeTo = currentBlock - chain.blockConfirmations;
  const lastBlockNumber = await getOrInitCursor(
    chainId,
    tokenAddress,
    currentBlock,
    chain.bootstrapBackfillBlocks
  );
  const fromBlock = lastBlockNumber + 1;

  if (fromBlock > safeTo) {
    return {
      chainId,
      scannedFrom: fromBlock,
      scannedTo: safeTo,
      hostCount: 0,
      eventCount: 0,
      insertedCount: 0,
    };
  }

  const toBlock = Math.min(safeTo, fromBlock + chain.maxBlockSpan - 1);

  // 2. Build address allow-list.
  const addresses = await getRegisteredHostAddresses();
  if (addresses.length === 0) {
    // Nothing to index, but still advance cursor so we don't replay the gap later.
    await updateCursor(chainId, tokenAddress, toBlock);
    return {
      chainId,
      scannedFrom: fromBlock,
      scannedTo: toBlock,
      hostCount: 0,
      eventCount: 0,
      insertedCount: 0,
    };
  }

  // 3. queryFilter per address chunk. Per-event upsert.
  let totalEvents = 0;
  let totalInserted = 0;
  const blockTimeCache = new Map<number, Date>();
  const roomIdCache = new Map<string, string | null>();

  for (let i = 0; i < addresses.length; i += CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + CHUNK_SIZE);

    const events = await withProviderForChain(chain, async (provider) => {
      const contract = new ethers.Contract(tokenAddress, ERC20_TRANSFER_ABI, provider);
      // filters.Transfer(from, to). `null` matches any from; chunk matches the
      // indexed `to` field via the ethers OR-by-array shortcut.
      const filter = contract.filters.Transfer(null, chunk);
      return contract.queryFilter(filter, fromBlock, toBlock);
    });

    totalEvents += events.length;

    for (const ev of events) {
      // Defensive: ev may be a Log or EventLog. We need decoded args; if absent skip.
      const log = ev as ethers.EventLog;
      const args = log.args;
      if (!args) continue;

      const fromAddress = (args[0] as string).toLowerCase();
      const toAddress = (args[1] as string).toLowerCase();
      const amount = (args[2] as bigint).toString();
      const txHash = log.transactionHash;
      const logIndex = log.index;
      const blockNumber = log.blockNumber;

      // Cache block timestamps to dodge N RPC calls for N events in the same block.
      let blockTime = blockTimeCache.get(blockNumber);
      if (!blockTime) {
        const blk = await withProviderForChain(chain, (p) => p.getBlock(blockNumber));
        if (!blk) {
          console.warn(
            `[UsdtIndexer][chain=${chainId}] Could not fetch block ${blockNumber}, skipping event`
          );
          continue;
        }
        blockTime = new Date(blk.timestamp * 1000);
        blockTimeCache.set(blockNumber, blockTime);
      }

      const roomId = await resolveRoomIdForAddress(toAddress, roomIdCache);

      // Upsert. (txHash, logIndex) is unique — re-org cleanup is automatic if
      // the same (tx, log) is re-emitted with new block data.
      const result = await prismaQuery.tipEvent.upsert({
        where: { txHash_logIndex: { txHash, logIndex } },
        create: {
          chainId,
          tokenAddress,
          fromAddress,
          toAddress,
          amount,
          txHash,
          logIndex,
          blockNumber,
          blockTime,
          roomId,
        },
        update: {
          // Only metadata that can shift on a re-org. amount/from/to are immutable
          // for a given (txHash, logIndex), so don't touch them.
          blockNumber,
          blockTime,
          roomId,
        },
      });
      const isInsert = result.createdAt.getTime() === result.updatedAt.getTime();
      if (isInsert) {
        totalInserted += 1;
        // F1: publish tip.confirmed to the activity feed. PII redaction at
        // publish-site per HIGH-04 — addresses shortened, tx hash kept full
        // (it's already public on-chain) so clients can link to a block explorer.
        // F10 (this PR): payload now carries chainId + chainName so the dashboard
        // (F8) can render a per-chain badge on the tip ticker.
        try {
          let roomSlug: string | null = null;
          if (roomId) {
            const room = await prismaQuery.room.findUnique({
              where: { id: roomId },
              select: { slug: true },
            });
            roomSlug = room?.slug ?? null;
          }
          eventBus.publish('tip.confirmed', {
            txHash,
            fromAddress: shortenAddress(fromAddress),
            toAddress: shortenAddress(toAddress),
            amount,
            amountFormatted: formatUsdt(amount),
            blockNumber,
            blockTime: blockTime.toISOString(),
            roomSlug,
            chainId,
            chainName: chain.name,
          });
        } catch (err) {
          // EventBus publish must never block indexer progress.
          console.warn(
            `[UsdtIndexer][chain=${chainId}] eventBus publish failed:`,
            (err as Error)?.message
          );
        }
      }
    }
  }

  // 4. Advance cursor only after the whole batch succeeded.
  await updateCursor(chainId, tokenAddress, toBlock);

  return {
    chainId,
    scannedFrom: fromBlock,
    scannedTo: toBlock,
    hostCount: addresses.length,
    eventCount: totalEvents,
    insertedCount: totalInserted,
  };
};

/**
 * Format USDT base units (6 decimals) for display. Always returns a string with
 * 6 fractional digits so client-side BigInt math stays consistent.
 */
export const formatUsdt = (baseUnits: string): string => {
  const bi = BigInt(baseUnits);
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const s = abs.toString().padStart(7, '0');
  const intPart = s.slice(0, -6);
  const fracPart = s.slice(-6);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
};
