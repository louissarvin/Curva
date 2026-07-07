// Pure EIP-3009 typed-data helpers.
//
// Extracted from the wallet worklet so signing logic is testable without WDK
// heavy dependencies. The wallet worklet imports these helpers, feeds them the
// account's signTypedData primitive, and returns { v, r, s } across IPC.
//
// Reference: https://eips.ethereum.org/EIPS/eip-3009
// Backend F11 mirror: /Users/macbookair/Documents/curva/backend/src/lib/evm/eip3009.ts
//
// The type object here MUST match the backend exactly. If the backend adds a
// field, this module must add it too — the recovery on the facilitator side
// will fail otherwise.

const crypto = require('hypercore-crypto')

// EIP-712 primary type name required by every EIP-3009 verifier.
const EIP3009_PRIMARY_TYPE = 'TransferWithAuthorization'

// Frozen so callers cannot mutate the singleton.
const EIP3009_TYPES = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ])
})

// Sepolia is our dev chain. Hard-coded because the app only ships this one for
// the hackathon demo. If you add a chain, thread it through bare/tip.js opts.
//
// `onChainIdentifier` is passed through to WalletManagerEvmErc4337 so any WDK
// account.transfer() call appends a 50-byte "curva" project marker to the
// UserOperation call data. Our primary tip path is EIP-3009 (backend F11
// facilitator, no UserOperation), but the marker still flows on any WDK-relayed
// operation we or downstream code may add. See:
// https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
// Docs allow both string ('curva') and object form; string is simplest.
const SEPOLIA = Object.freeze({
  chainId: 11155111,
  provider: 'https://ethereum-sepolia-rpc.publicnode.com',
  bundlerUrl: 'https://api.candide.dev/public/v3/11155111',
  paymasterUrl: 'https://api.candide.dev/public/v3/11155111',
  paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
  usdtAddress: '0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739',
  // The backend F11 fetches token name+version from the contract via `name()`
  // + `EIP712_VERSION()`/`version()`. Verified via `cast call name()` on
  // 0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739 (Sepolia): the contract returns
  // the string "Tether USD" (10 bytes) and version "1". Prior fallback of
  // "USDT" caused ECDSA recovery mismatch on the facilitator side because the
  // EIP-712 domain hash differs when `name` differs. If the runtime probe of
  // /wdk/token-domain succeeds it still overrides these defaults.
  tokenName: 'Tether USD',
  tokenVersion: '1',
  onChainIdentifier: 'curva'
})

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Build an EIP-712 typed-data object for TransferWithAuthorization.
 *
 * The returned object is the exact shape `account.signTypedData(typedData)`
 * from `@tetherto/wdk-wallet-evm-erc-4337` expects, and also the shape ethers
 * `verifyTypedData` uses to recover the signer. Signing on the OWNER EOA (not
 * the smart account) is critical — the F11 facilitator recovers against the
 * `from` field, which for us is the peer's EOA address.
 *
 * @param {object} opts
 * @param {number} opts.chainId          - integer, e.g. 11155111
 * @param {string} opts.tokenAddress     - 0x... USDT contract
 * @param {string} opts.tokenName        - EIP-712 domain name (e.g. 'USDT')
 * @param {string} opts.tokenVersion     - EIP-712 domain version (e.g. '1')
 * @param {string} opts.from             - EOA of sender (owner of Safe smart account)
 * @param {string} opts.to               - recipient smart address (host)
 * @param {string} opts.value            - decimal string, base units (BigInt-safe)
 * @param {number} opts.validAfter       - unix seconds
 * @param {number} opts.validBefore      - unix seconds
 * @param {string} opts.nonce            - 0x-prefixed 32-byte hex
 * @returns {object}                       { domain, types, primaryType, message }
 */
function buildTypedData(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('opts required')
  const {
    chainId,
    tokenAddress,
    tokenName,
    tokenVersion,
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce
  } = opts

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new RangeError('chainId must be positive integer')
  }
  if (typeof tokenAddress !== 'string' || !ADDR_RE.test(tokenAddress)) {
    throw new RangeError('tokenAddress must be 0x-prefixed 20-byte hex')
  }
  if (typeof tokenName !== 'string' || tokenName.length === 0) {
    throw new RangeError('tokenName required')
  }
  if (typeof tokenVersion !== 'string' || tokenVersion.length === 0) {
    throw new RangeError('tokenVersion required')
  }
  if (typeof from !== 'string' || !ADDR_RE.test(from)) {
    throw new RangeError('from must be 0x-prefixed 20-byte hex')
  }
  if (typeof to !== 'string' || !ADDR_RE.test(to)) {
    throw new RangeError('to must be 0x-prefixed 20-byte hex')
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new RangeError('value must be decimal string')
  }
  // BigInt round-trip guards against overflow and negative injection.
  let valueBig
  try {
    valueBig = BigInt(value)
  } catch {
    throw new RangeError('value not a valid uint')
  }
  if (valueBig <= 0n) throw new RangeError('value must be > 0')
  if (!Number.isInteger(validAfter) || validAfter < 0) {
    throw new RangeError('validAfter must be non-negative integer')
  }
  if (!Number.isInteger(validBefore) || validBefore <= validAfter) {
    throw new RangeError('validBefore must be integer > validAfter')
  }
  if (typeof nonce !== 'string' || !HEX32_RE.test(nonce)) {
    throw new RangeError('nonce must be 0x-prefixed 32-byte hex')
  }

  return {
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId,
      // Lowercased so the digest matches whatever the F11 facilitator computes.
      verifyingContract: tokenAddress.toLowerCase()
    },
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: {
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value,
      validAfter,
      validBefore,
      nonce: nonce.toLowerCase()
    }
  }
}

/**
 * Cryptographically strong 32-byte hex nonce, 0x-prefixed. Uses
 * hypercore-crypto (libsodium) which is already in the dep tree. Must NOT be
 * sequential — the token contract enforces one-time-use per (from, nonce) pair.
 */
function randomNonce() {
  const buf = crypto.randomBytes(32)
  // Manual hex encoding — no b4a here to keep this module independent of the
  // hyper-* runtime for straightforward testing.
  let hex = '0x'
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Split a 0x-prefixed 65-byte signature into { v, r, s }. Accepts both
 * classic (v = 27/28) and EIP-2098 short signatures via v = 0/1 by rebuilding
 * to canonical 27/28 range. Returns { v, r, s } with r and s 0x-prefixed
 * bytes32 hex.
 *
 * @param {string} sigHex
 * @returns {{ v: number, r: string, s: string }}
 */
function splitSignature(sigHex) {
  if (typeof sigHex !== 'string') {
    throw new TypeError('sigHex must be string')
  }
  const clean = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new RangeError('sigHex must be hex')
  }
  if (clean.length !== 130) {
    throw new RangeError('sigHex must be 65 bytes (130 hex chars)')
  }
  const r = '0x' + clean.slice(0, 64).toLowerCase()
  const s = '0x' + clean.slice(64, 128).toLowerCase()
  let v = parseInt(clean.slice(128, 130), 16)
  // Normalize v to the canonical 27/28 range expected by ethers.Signature.
  if (v === 0 || v === 1) v += 27
  return { v, r, s }
}

module.exports = {
  buildTypedData,
  randomNonce,
  splitSignature,
  EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE,
  SEPOLIA,
  // Hard-coded demo cap. Matches ARCHITECTURE.md open question 6 answer.
  DEMO_AMOUNT_BASE_UNITS: '1000000',
  DEMO_AMOUNT_DECIMAL: '1',
  DEMO_TOKEN_DECIMALS: 6
}
