/**
 * generate-secrets.ts
 *
 * Prints copy-paste-ready secrets for `.env`:
 *   - SEEDER_NOISE_SEED  32-byte hex (Hyperswarm identity)
 *   - RELAY_SPONSOR_PK   fresh Sepolia EOA private key + address
 *
 * Usage:  bun run generate:secrets -- --confirm-print-secrets
 *
 * Security notes:
 *   - The script REFUSES to print a private key without an explicit confirm
 *     flag (--confirm-print-secrets or --i-understand-this-prints-secrets).
 *   - Run in a fresh terminal.
 *   - Consider: set +o history before running to avoid shell history capture.
 *   - Set umask 077 before running so any accidental redirect inherits
 *     owner-only permissions.
 *   - Do NOT redirect stdout to a file; the printed private key is meant to be
 *     copy-pasted into .env, not persisted on disk.
 *   - Private keys are written to STDOUT ONLY. Never commit them to git.
 *   - The EOA is deterministic ONLY within this process — a fresh call
 *     generates a fresh key. Save the printed values to .env before exit.
 */

import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

const line = (): void => console.log('-'.repeat(72));

const CONFIRM_FLAGS = new Set([
  '--confirm-print-secrets',
  '--i-understand-this-prints-secrets',
]);

const hasConfirmFlag = (): boolean => {
  for (const arg of process.argv.slice(2)) {
    if (CONFIRM_FLAGS.has(arg)) return true;
  }
  return false;
};

const printInstructions = (): void => {
  console.log('');
  line();
  console.log('  CURVA BACKEND — SECRETS GENERATOR');
  line();
  console.log('');
  console.log('  Refusing to print secrets without an explicit confirm flag.');
  console.log('');
  console.log('  This script prints a fresh Sepolia sponsor private key to STDOUT.');
  console.log('  Before running:');
  console.log('    - Run in a fresh terminal (no other apps observing stdout).');
  console.log('    - Consider: `set +o history` to avoid shell history capture.');
  console.log('    - Set `umask 077` so any accidental redirect is owner-only.');
  console.log('    - Do NOT redirect stdout to a file; copy-paste into .env only.');
  console.log('');
  console.log('  To confirm you understand, re-run with:');
  console.log('    bun run generate:secrets -- --confirm-print-secrets');
  console.log('');
  line();
  console.log('');
};

const main = async (): Promise<void> => {
  if (!hasConfirmFlag()) {
    printInstructions();
    process.exit(0);
  }

  const seed = randomBytes(32).toString('hex');
  const wallet = ethers.Wallet.createRandom();

  console.log('');
  line();
  console.log('  CURVA BACKEND — SECRETS GENERATOR');
  line();
  console.log('');
  console.log('  WARNING');
  console.log('  Private key is about to be printed to STDOUT.');
  console.log('  - Run in a fresh terminal.');
  console.log('  - Consider `set +o history` before running.');
  console.log('  - Set `umask 077` before running.');
  console.log('  - Do NOT redirect stdout to a file.');
  console.log('  - Private keys must NEVER be committed to git.');
  console.log('');
  line();
  console.log('');
  console.log('  1) Pears seeder noise seed (32 bytes, hex)');
  console.log('');
  console.log(`SEEDER_NOISE_SEED=${seed}`);
  console.log('');
  line();
  console.log('');
  console.log('  2) Fresh Sepolia sponsor EOA for the WDK EIP-3009 facilitator');
  console.log('');
  console.log(`     Address:     ${wallet.address}`);
  console.log(`     Private key: ${wallet.privateKey}`);
  console.log('');
  console.log('  Add to .env:');
  console.log('');
  console.log(`RELAY_SPONSOR_PK=${wallet.privateKey}`);
  console.log('RELAY_SPONSOR_ENABLED=true');
  console.log('');
  console.log('  Fund the EOA at the Sepolia faucet before enabling the facilitator:');
  console.log('    https://cloud.google.com/application/web3/faucet/ethereum/sepolia');
  console.log('    https://sepolia-faucet.pk910.de');
  console.log('');
  line();
  console.log('');
  console.log('  Verify .env is in .gitignore before pasting the values above.');
  console.log('');
  line();
  console.log('');
};

void main().catch((err) => {
  console.error('[generate-secrets] failed:', (err as Error)?.message ?? err);
  process.exit(1);
});
