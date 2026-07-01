/**
 * Wave 14 - unit tests for src/lib/evm/attendance.ts.
 *
 * Pure function tests. Uses ethers to sign a canonical attendance message and
 * verifies the recovery / expiry / mismatch code paths without booting Fastify.
 */

import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  buildAttendanceMessage,
  verifyAttendancePass,
} from '../../../src/lib/evm/attendance.ts';

const HOST_PK = '0x' + 'aa'.repeat(32);
const OTHER_PK = '0x' + 'bb'.repeat(32);
const PEER_ADDRESS = '0x' + '11'.repeat(20);

const host = new ethers.Wallet(HOST_PK);
const other = new ethers.Wallet(OTHER_PK);

const nowSec = () => Math.floor(Date.now() / 1000);

describe('buildAttendanceMessage', () => {
  test('produces the canonical curva-attendance-pass v1 shape', () => {
    const msg = buildAttendanceMessage({
      slug: 'curva-sud-torino',
      matchId: 'match-1',
      peerAddress: PEER_ADDRESS,
      issuedAt: 1_700_000_000,
    });
    expect(msg).toBe(
      `curva-attendance-pass:v1:curva-sud-torino:match-1:${PEER_ADDRESS.toLowerCase()}:1700000000`
    );
  });

  test('lowercases the slug and peer address', () => {
    const msg = buildAttendanceMessage({
      slug: 'CURVA-SUD',
      matchId: '',
      peerAddress: '0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333',
      issuedAt: 1_700_000_000,
    });
    expect(msg).toContain('curva-sud');
    expect(msg).toContain('0xaaaabbbbccccddddeeeeffff0000111122223333');
  });
});

describe('verifyAttendancePass', () => {
  const validSlug = 'curva-sud-torino';
  const validMatchId = 'match-1';

  const buildValid = async (overrides: Partial<Parameters<typeof verifyAttendancePass>[0]> = {}) => {
    const issuedAt = overrides.issuedAt ?? nowSec();
    const message = buildAttendanceMessage({
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt,
    });
    const signature = await host.signMessage(message);
    return {
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt,
      signature,
      expectedHostAddress: host.address.toLowerCase(),
      ...overrides,
    };
  };

  test('recovers the host address and returns valid:true', async () => {
    const res = verifyAttendancePass(await buildValid());
    expect(res.valid).toBe(true);
    expect(res.recoveredHostAddress).toBe(host.address.toLowerCase());
    expect(res.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  test('accepts an unregistered room (no expectedHostAddress)', async () => {
    const input = await buildValid();
    delete (input as Record<string, unknown>).expectedHostAddress;
    const res = verifyAttendancePass(input);
    expect(res.valid).toBe(true);
    expect(res.recoveredHostAddress).toBe(host.address.toLowerCase());
  });

  test('rejects HOST_MISMATCH when signature is from a different key', async () => {
    const issuedAt = nowSec();
    const msg = buildAttendanceMessage({
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt,
    });
    const badSig = await other.signMessage(msg);
    const res = verifyAttendancePass({
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt,
      signature: badSig,
      expectedHostAddress: host.address.toLowerCase(),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('HOST_MISMATCH');
  });

  test('rejects SIGNATURE_MALFORMED for garbage signature', () => {
    const res = verifyAttendancePass({
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt: nowSec(),
      signature: '0xdead',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('SIGNATURE_MALFORMED');
  });

  test('rejects EXPIRED when pass is older than maxAgeSeconds', async () => {
    const oldTs = nowSec() - 25 * 60 * 60; // 25h ago
    const res = verifyAttendancePass(await buildValid({ issuedAt: oldTs }));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('EXPIRED');
  });

  test('rejects ADDRESS_INVALID for a malformed peer address', () => {
    const res = verifyAttendancePass({
      slug: validSlug,
      matchId: validMatchId,
      peerAddress: 'not-a-hex-address',
      issuedAt: nowSec(),
      signature: '0x' + '11'.repeat(65),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('ADDRESS_INVALID');
  });

  test('rejects SLUG_INVALID for a bad slug', () => {
    const res = verifyAttendancePass({
      slug: '--!!!--',
      matchId: validMatchId,
      peerAddress: PEER_ADDRESS,
      issuedAt: nowSec(),
      signature: '0x' + '11'.repeat(65),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('SLUG_INVALID');
  });
});
