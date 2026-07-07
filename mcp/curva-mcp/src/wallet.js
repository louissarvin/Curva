// WDK wallet bootstrap. Mirrors pear-app/bare/wallet/worklet.js so signatures
// produced here are byte-identical to what the Pear peer would produce.
//
// Docs verified:
//   - https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
//     confirms constructor: new WalletManagerEvmErc4337(seed, config) with
//     chainId, provider, bundlerUrl, paymasterUrl, paymasterAddress, safeModulesVersion,
//     paymasterToken.address, and optional onChainIdentifier.
//   - The F11 facilitator recovers the EOA from the ECDSA signature, NOT the
//     Safe 4337 smart account. If we sign with account.signTypedData() the
//     Safe returns an ERC-1271 pre-validated signature that the facilitator
//     cannot ecrecover. So we keep an EOA signer around and use it for every
//     EIP-3009 typed-data / EIP-191 personal_sign call.
//     Reference: /Users/macbookair/Documents/curva/pear-app/bare/wallet/worklet.js
//                and memory: project_curva_signature_model.md

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337';
import { ethers } from 'ethers';
import { CONFIG } from './config.js';
import { logJson } from './safety.js';

let cached = null;

// One wallet instance per process is enough. The WDK toolkit wipes keys on
// server.close(), so we do not clear the cache between tool calls.
export async function createCurvaWallet() {
  if (cached) return cached;

  const seed = CONFIG.seed; // throws if unset
  let wallet;
  try {
    wallet = new WalletManagerEvmErc4337(seed, {
      chainId: CONFIG.chainId,
      provider: CONFIG.provider,
      bundlerUrl: CONFIG.bundlerUrl,
      paymasterUrl: CONFIG.paymasterUrl,
      paymasterAddress: CONFIG.paymasterAddress,
      safeModulesVersion: '0.3.0',
      paymasterToken: { address: CONFIG.usdtAddress },
      onChainIdentifier: CONFIG.onChainIdentifier,
    });
  } catch (err) {
    logJson('error', 'wallet.init_failed', { message: err?.message });
    throw new Error(`WALLET_INIT_FAILED: ${err?.message || 'unknown'}`);
  }

  const account = await wallet.getAccount(0);
  const smartAddress = (await account.getAddress()).toLowerCase();

  // Owner EOA. Derived from the same seed. ethers uses the standard BIP-44
  // path m/44'/60'/0'/0/0 by fromPhrase; the WDK wallet does the same for its
  // first EOA so both addresses match.
  const hd = ethers.HDNodeWallet.fromPhrase(seed);
  const ownerSigner = new ethers.Wallet(hd.privateKey);
  const ownerAddress = ownerSigner.address.toLowerCase();

  cached = { wallet, account, smartAddress, ownerAddress, ownerSigner };
  logJson('info', 'wallet.ready', {
    smartAddress,
    ownerAddress,
    chainId: CONFIG.chainId,
  });
  return cached;
}

// Clear cached signer refs. Called on graceful shutdown so we do not hold key
// material after the transport closes.
export function forgetWallet() {
  cached = null;
}
