// Curva wallet worklet.
//
// Owns the seed. Exports a factory that builds a WalletAdapter with three
// operations:
//   - init(opts)           -> { smartAddress, ownerAddress, chainId, balance }
//   - signEip3009(message) -> { v, r, s, from }
//   - dispose()
//
// ARCHITECTURE.md ADR-004 mandates a dedicated Bare worklet for the seed.
// For hackathon Phase 3 we ship OPTION B: the wallet lives in this module's
// closure, imported once by bare/room.js on the main Bare worker. Seed is
// module-scoped and never written to any wire, log, or IPC message. Full
// worker-process isolation is a v2 hardening item (see the trailing TODO
// notice printed at init time). This is documented as ADR-004 open question.
//
// Passcode discipline (open question 6):
//   - Read from env DEV_WALLET_PASSCODE (never hardcoded).
//   - Production must swap to an OS-keychain-backed prompt.
//
// Signing discipline:
//   - We sign with the OWNER EOA (not the smart account). The F11 facilitator
//     recovers the EOA from the ECDSA signature and matches it to the `from`
//     field. If we ever signed with the smart account instead, the facilitator
//     would return SIGNATURE_INVALID and the tip would fail.
//   - `account.signTypedData()` from wdk-wallet-evm-erc-4337 signs with the
//     underlying EOA per docs (tech/02_wdk_technical.md §3.5).
//   - If WDK signTypedData returns a signature that does NOT recover to the
//     EOA (some Safe 4337 variants use ERC-1271 smart-contract signatures),
//     we fall back to ethers directly with a wallet derived from the seed.

const {
  buildTypedData,
  randomNonce,
  splitSignature,
  SEPOLIA,
  DEMO_AMOUNT_BASE_UNITS
} = require('./eip3009.js')

// Redact-safe log prefix.
const LOG = '[Curva][Wallet]'

// Tier 4: ERC-4337 batch tip. ERC-20 transfer(address,uint256) selector is
// 0xa9059cbb per the ERC-20 spec. Calldata is encoded via ethers.Interface at
// call time so that we use the same encoder ethers itself validates against.
const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)']

// Per-batch guardrails. The SDK has no batch-size limit (verified in the
// wallet-account-evm-erc-4337 source: sendTransaction calls [tx].flat() on
// input). We enforce a 2..5 recipient window and a 15 USDT total cap purely
// as a client-side safety ceiling for the demo, matching the task spec.
const BATCH_MIN_RECIPIENTS = 2
const BATCH_MAX_RECIPIENTS = 5
const BATCH_MAX_TOTAL_ATOMIC = 15_000000n // 15 USDT with 6 decimals

/**
 * Create a wallet adapter around the given WDK factory.
 *
 * @param {object} deps
 * @param {Function} [deps.WalletFactory]  wdk-wallet-evm-erc-4337 default export
 * @param {object}   [deps.SecretManager]  wdk-secret-manager default export
 * @param {object}   [deps.ethers]         ethers module (for signature recovery fallback)
 * @param {object}   [deps.WDK]            wdk default export (for getRandomSeedPhrase)
 * @param {string}   [deps.storageDir]     where SecretManager persists encrypted secrets
 * @param {string}   [deps.passcode]       user's passcode; MUST come from env, never hardcoded
 * @param {object}   [deps.chain]          chain config; defaults to SEPOLIA
 */
function createWalletAdapter(deps = {}) {
  const chain = deps.chain || SEPOLIA
  let disposed = false
  let initialized = false
  let smartAddress = null
  let ownerAddress = null
  let account = null       // WDK account (Safe 4337)
  let fallbackSigner = null // ethers.Wallet, used only if account.signTypedData() misbehaves
  // Fix Wave B / T3: cached EIP-712 token domain (name + version) probed from
  // the backend /wdk/token-domain endpoint at init time. Falls back to the
  // hardcoded chain.tokenName / chain.tokenVersion when the fetch fails, so
  // the wallet still works offline (the demo target USDT-Sepolia matches the
  // fallback exactly). Docs cross-check:
  // https://eips.ethereum.org/EIPS/eip-3009 §EIP712Domain — domain name/version
  // MUST match what the token contract reports for `verifyTypedData` to work.
  let dynamicTokenName = null
  let dynamicTokenVersion = null

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  async function init(opts = {}) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (initialized) {
      return { smartAddress, ownerAddress, chainId: chain.chainId, balance: '0' }
    }
    const passcode = opts.passcode ?? deps.passcode
    if (typeof passcode !== 'string' || passcode.length < 4) {
      throw new WalletError(
        'WALLET_PASSCODE_REQUIRED',
        'passcode must be a non-empty string (>=4 chars)'
      )
    }
    const storageDir = opts.storageDir ?? deps.storageDir
    if (typeof storageDir !== 'string' || storageDir.length === 0) {
      throw new WalletError('WALLET_STORAGE_REQUIRED', 'storageDir required')
    }

    // Load or generate a seed via SecretManager. NEVER log the seed.
    const seed = await loadOrCreateSeed({
      SecretManager: deps.SecretManager,
      WDK: deps.WDK,
      passcode,
      storageDir
    })

    // Instantiate WalletManagerEvmErc4337. `paymasterToken.address` set so USDT
    // pays gas; we don't need any sponsorship signup for the demo.
    const WalletFactory = deps.WalletFactory
    if (typeof WalletFactory !== 'function') {
      throw new WalletError(
        'WALLET_NO_FACTORY',
        'WalletFactory (wdk-wallet-evm-erc-4337) not provided'
      )
    }
    // onChainIdentifier: docs at
    // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
    // say this appends a 50-byte project marker to every UserOperation's call
    // data so Tether can attribute WDK-relayed traffic. We use the object form
    // per the docs so `platform`, `tool`, and `toolVersion` are attributed
    // correctly. `platform` is a CLOSED enum: 'Web' | 'Mobile' | 'Safe App' |
    // 'Widget'. 'Pear-runtime' is NOT a valid enum value; we map Pear runtime
    // to 'Widget' (closest match for a runtime plug-in) and stash the Pear
    // identity in `tool` so downstream analytics can still bucket us cleanly.
    // See memory/impl_onchain_identifier.md.
    const factoryOptions = {
      chainId: chain.chainId,
      provider: chain.provider,
      bundlerUrl: chain.bundlerUrl,
      paymasterUrl: chain.paymasterUrl,
      paymasterAddress: chain.paymasterAddress,
      safeModulesVersion: '0.3.0',
      paymasterToken: { address: chain.usdtAddress },
      onChainIdentifier: {
        project: 'curva',
        platform: 'Widget',
        tool: 'curva-wallet',
        toolVersion: '0.1.0'
      }
    }
    const wallet = new WalletFactory(seed, factoryOptions)
    account = await wallet.getAccount(0)
    smartAddress = String(await account.getAddress()).toLowerCase()

    // Derive the EOA (owner) address from the seed via ethers. WDK doesn't
    // publicly expose the owner EOA on the erc-4337 account interface as of
    // 1.0.0-beta.10; standard BIP-44 derivation path m/44'/60'/0'/0/0 matches
    // WDK's internal derivation.
    if (deps.ethers) {
      try {
        const hd = deps.ethers.HDNodeWallet.fromPhrase(seed)
        // fromPhrase gives the m/44'/60'/0'/0/0 wallet by default.
        fallbackSigner = new deps.ethers.Wallet(hd.privateKey)
        ownerAddress = String(fallbackSigner.address).toLowerCase()
      } catch (err) {
        // If HD derivation fails we can still function via account.signTypedData
        // — but we won't be able to fall back on recovery mismatch.
        console.warn(LOG, 'HD derivation for fallback signer failed:', err.message)
        ownerAddress = smartAddress // will not verify; caller MUST supply correct from
      }
    } else {
      ownerAddress = smartAddress
    }

    // Fix Wave B / T3: probe on-chain EIP-712 domain for USDT via the backend
    // so client-side digest matches the F11 facilitator's recovery. Never
    // blocks init on failure — fall back to hardcoded chain.tokenName/Version
    // and log a structured warning. Cached in closure for the wallet lifetime.
    const backendBaseUrl = opts.backendBaseUrl ?? deps.backendBaseUrl
    const fetchFn = deps.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null)
    if (typeof backendBaseUrl === 'string' && backendBaseUrl.length > 0 && typeof fetchFn === 'function') {
      try {
        const url = backendBaseUrl.replace(/\/$/, '') +
          '/wdk/token-domain?chainId=' + encodeURIComponent(String(chain.chainId)) +
          '&token=' + encodeURIComponent(chain.usdtAddress)
        const res = await fetchFn(url, { method: 'GET' })
        if (res && res.ok) {
          const body = await res.json()
          const d = body && body.data
          if (d && typeof d.name === 'string' && typeof d.version === 'string') {
            dynamicTokenName = d.name
            dynamicTokenVersion = d.version
            if (dynamicTokenName !== chain.tokenName || dynamicTokenVersion !== chain.tokenVersion) {
              console.log(LOG, 'token domain differs from hardcoded default:',
                JSON.stringify({ name: dynamicTokenName, version: dynamicTokenVersion }))
            }
          }
        } else if (res) {
          console.warn(LOG, 'token-domain probe non-2xx status=' + res.status +
            ' — falling back to chain defaults')
        }
      } catch (err) {
        console.warn(LOG, 'token-domain probe failed:', err.message,
          '— falling back to chain defaults')
      }
    }

    initialized = true
    console.log(LOG, 'initialized (hackathon Option B: seed is module-scoped)')
    return {
      smartAddress,
      ownerAddress,
      chainId: chain.chainId,
      tokenName: dynamicTokenName || chain.tokenName,
      tokenVersion: dynamicTokenVersion || chain.tokenVersion,
      balance: '0' // balance queried separately to avoid slowing init
    }
  }

  // ---------------------------------------------------------------------------
  // signEip3009
  // ---------------------------------------------------------------------------
  async function signEip3009(msg = {}) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (!initialized) throw new WalletError('WALLET_NOT_INIT', 'wallet not initialized')

    const nonce = msg.nonce || randomNonce()
    const nowSec = Math.floor(Date.now() / 1000)
    const validAfter = Number.isInteger(msg.validAfter) ? msg.validAfter : Math.max(0, nowSec - 60)
    const validBefore = Number.isInteger(msg.validBefore) ? msg.validBefore : nowSec + 15 * 60

    // `from` MUST be the owner EOA. We do NOT trust the caller to pass this
    // correctly — enforce it here.
    const typedData = buildTypedData({
      chainId: msg.chainId ?? chain.chainId,
      tokenAddress: msg.tokenAddress || chain.usdtAddress,
      // Prefer the dynamic domain probed at init time (Fix Wave B / T3). Falls
      // back to hardcoded chain defaults if the probe failed. Caller override
      // (msg.tokenName / msg.tokenVersion) still wins for test-fixture setups.
      tokenName: msg.tokenName || dynamicTokenName || chain.tokenName,
      tokenVersion: msg.tokenVersion || dynamicTokenVersion || chain.tokenVersion,
      from: ownerAddress,
      to: msg.to,
      value: msg.value,
      validAfter,
      validBefore,
      nonce
    })

    // Preferred path: ethers.js Wallet signs the typed data with the EOA.
    // This is deterministic and always recovers correctly.
    // Rationale: WDK's Safe 4337 signTypedData() may return an ERC-1271 or
    // Safe-flavored signature depending on Safe module version, which the F11
    // facilitator cannot recover with plain ecrecover. See
    // ARCHITECTURE.md §12.3.
    if (fallbackSigner && typeof fallbackSigner.signTypedData === 'function') {
      // ethers accepts the plain type object without primaryType key.
      const flatTypes = { ...typedData.types }
      // ethers.signTypedData expects types WITHOUT EIP712Domain.
      const sigHex = await fallbackSigner.signTypedData(
        typedData.domain,
        flatTypes,
        typedData.message
      )
      const { v, r, s } = splitSignature(sigHex)
      return {
        v,
        r,
        s,
        from: ownerAddress,
        nonce,
        validAfter,
        validBefore,
        typedData
      }
    }

    // Fallback: WDK account signing (only if HD derivation failed above).
    if (typeof account?.signTypedData !== 'function') {
      throw new WalletError(
        'WALLET_NO_SIGNER',
        'no ethers HD signer and account.signTypedData unavailable'
      )
    }
    const sigHex = await account.signTypedData(typedData)
    if (typeof sigHex !== 'string' || sigHex.length < 130) {
      throw new WalletError('WALLET_SIGN_FAILED', 'signTypedData returned malformed signature')
    }
    const { v, r, s } = splitSignature(sigHex)
    return {
      v,
      r,
      s,
      from: ownerAddress,
      nonce,
      validAfter,
      validBefore,
      typedData
    }
  }

  // ---------------------------------------------------------------------------
  // signMessage: Wave 6 T14. Simple EIP-191 personal-message signature. Signed
  // by the owner EOA (same key that signs EIP-3009 typed data). Used to emit
  // a `system:tip-ack` receipt from the host when they receive a tip.
  //   - Never prompts (uses in-process key, hackathon Option B).
  //   - Uses ethers' fallbackSigner.signMessage which produces a standard
  //     personal_sign envelope. Anyone can ecrecover the address off-chain.
  // ---------------------------------------------------------------------------
  async function signMessage(text) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (!initialized) throw new WalletError('WALLET_NOT_INIT', 'wallet not initialized')
    if (typeof text !== 'string' || text.length === 0 || text.length > 1024) {
      throw new WalletError('WALLET_MSG_INVALID', 'text must be 1-1024 chars')
    }
    if (fallbackSigner && typeof fallbackSigner.signMessage === 'function') {
      const sig = await fallbackSigner.signMessage(text)
      return { signature: sig, signer: ownerAddress, text }
    }
    // WDK EOA-level signing is `account.sign(message)` per
    // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
    // "Signs a message using the account's private key" (operates on the
    // underlying EOA, NOT the Safe smart account). Returns Promise<string>.
    if (typeof account?.sign === 'function') {
      const sig = await account.sign(text)
      return { signature: sig, signer: ownerAddress, text }
    }
    throw new WalletError('WALLET_NO_SIGNER', 'no signer available for signMessage')
  }

  // ---------------------------------------------------------------------------
  // signAttendance: Wave 14. Off-chain EIP-191 attendance-pass signature.
  //
  // Builds the canonical bytes-signed-by-host message
  //   curva-attendance-pass:v1:<slug>:<matchId>:<peerAddress>:<issuedAt>
  // and delegates to the existing owner-EOA signMessage path (same key that
  // signs system:tip-ack via Wave 6 T14). Verifier is off-chain — no gas, no
  // paymaster, no on-chain settlement — so this method never prompts and
  // never touches the smart account.
  //
  // Kept in the worklet so the seed never leaves this closure. The bare/
  // attendance.js module holds nothing sensitive and only sees the returned
  // hex string.
  // ---------------------------------------------------------------------------
  async function signAttendance({ slug, matchId, peerAddress, issuedAt } = {}) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (!initialized) throw new WalletError('WALLET_NOT_INIT', 'wallet not initialized')
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 128) {
      throw new WalletError('ATTENDANCE_SLUG_INVALID', 'slug must be 1-128 chars')
    }
    if (typeof peerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(peerAddress)) {
      throw new WalletError('ATTENDANCE_ADDRESS_INVALID', 'peerAddress must be 0x + 20-byte hex')
    }
    const ts = Math.floor(Number(issuedAt) || 0)
    if (!Number.isFinite(ts) || ts <= 0) {
      throw new WalletError('ATTENDANCE_ISSUED_AT_INVALID', 'issuedAt must be positive unix seconds')
    }
    const mid = typeof matchId === 'string' ? matchId : ''
    const message =
      `curva-attendance-pass:v1:${String(slug).toLowerCase().trim()}:${mid.trim()}:` +
      `${peerAddress.toLowerCase().trim()}:${ts}`

    // signMessage already prefers the ethers fallback signer (EOA), falling
    // back to account.sign per WDK docs. We reuse that path so the on-chain
    // trust model (owner EOA controls the receipt key) is identical to Wave 6
    // T14 tip-ack.
    const res = await signMessage(message)
    return {
      signature: res.signature,
      hostAddress: res.signer,
      message
    }
  }

  // ---------------------------------------------------------------------------
  // getInfo
  // ---------------------------------------------------------------------------
  function getInfo() {
    return {
      initialized,
      disposed,
      smartAddress,
      ownerAddress,
      chainId: chain.chainId
    }
  }

  async function getBalance() {
    if (!initialized || !account) return '0'
    try {
      if (typeof account.getTokenBalance !== 'function') return '0'
      const bal = await account.getTokenBalance(chain.usdtAddress)
      return typeof bal === 'bigint' ? bal.toString() : String(bal)
    } catch (err) {
      console.warn(LOG, 'balance fetch failed:', err.message)
      return '0'
    }
  }

  // ---------------------------------------------------------------------------
  // Wave 8C: ERC-4337 UserOp fallback path.
  //
  // Sends USDT from the smart-account via account.transfer() when the primary
  // EIP-3009 facilitator path (F11) is down. This path uses WDK's built-in
  // UserOperation submission through the bundler + ERC-20 paymaster mode:
  // the smart-account itself must hold enough USDT to cover both the transfer
  // amount and the paymaster fee (docs:
  // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
  // - paymasterToken.address = Sepolia USDT).
  //
  // Return shape: per docs at
  // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
  // account.transfer resolves to `{ hash, fee }` where `hash` is the
  // UserOperation hash. We expose both `txHash` and `userOpHash` for
  // downstream compat: judges reading the tip row can see the userOp hash
  // immediately, and the confirmation SSE will backfill the real on-chain
  // tx hash once the bundler includes the userOp.
  //
  // Errors: WDK throws on (a) fee exceeds transferMaxFee, (b) insufficient
  // token balance. We surface both as structured USEROP_FAILED errors with
  // phase='submit' so tip.js can present a clear "smart-account not funded"
  // banner without leaking WDK internals to the log.
  // ---------------------------------------------------------------------------
  async function sendUsdtViaAccountTransfer({ recipient, amount } = {}) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (!initialized) throw new WalletError('WALLET_NOT_INIT', 'wallet not initialized')
    if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      throw new WalletError('USEROP_INVALID_RECIPIENT', 'recipient must be 0x + 20-byte hex')
    }
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
      throw new WalletError('USEROP_INVALID_AMOUNT', 'amount must be decimal base-unit string')
    }
    let amountBig
    try { amountBig = BigInt(amount) } catch {
      throw new WalletError('USEROP_INVALID_AMOUNT', 'amount not a valid uint')
    }
    if (amountBig <= 0n) {
      throw new WalletError('USEROP_INVALID_AMOUNT', 'amount must be > 0')
    }
    if (typeof account?.transfer !== 'function') {
      throw new WalletError('USEROP_UNSUPPORTED', 'account.transfer not available on this WDK build')
    }

    let result
    try {
      // Docs signature: account.transfer({ token, recipient, amount: bigint })
      // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
      result = await account.transfer({
        token: chain.usdtAddress,
        recipient: recipient.toLowerCase(),
        amount: amountBig
      })
    } catch (err) {
      const msg = err?.message || String(err)
      // Detect the two documented failure modes so the caller can surface a
      // useful message. Balance failures dominate on fresh smart accounts.
      const balanceHit = /insufficient|balance/i.test(msg)
      const feeHit = /fee.*exceed|transferMaxFee/i.test(msg)
      const code = balanceHit
        ? 'USEROP_INSUFFICIENT_BALANCE'
        : feeHit
          ? 'USEROP_FEE_EXCEEDED'
          : 'USEROP_FAILED'
      throw new WalletError(code, `account.transfer failed: ${msg}`)
    }

    if (!result || typeof result !== 'object') {
      throw new WalletError('USEROP_BAD_RESPONSE', 'account.transfer returned no result')
    }

    // Adapter: WDK docs declare `hash` but future/other builds may return
    // `txHash` or `userOpHash`. Normalize to a single shape so tip.js has one
    // reliable spot to read from. Fee is optional (bigint) — stringify safely.
    const rawHash = result.hash || result.userOpHash || result.txHash
    if (typeof rawHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
      throw new WalletError('USEROP_BAD_RESPONSE', 'account.transfer returned no hash-like field')
    }
    const hashLower = rawHash.toLowerCase()
    const fee = typeof result.fee === 'bigint'
      ? result.fee.toString()
      : (result.fee != null ? String(result.fee) : null)

    return {
      txHash: hashLower,       // best-available identifier for the log row
      userOpHash: hashLower,   // explicit alias so judges know it's a userOp
      fee
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 4: ERC-4337 batch tip.
  //
  // Composes N ERC-20 `transfer(address,uint256)` calls into a single
  // UserOperation and submits it via WDK's account.sendTransaction. The WDK
  // wraps the array in a Safe MultiSend DELEGATECALL through the default
  // contract 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526 (selector 0x8d80ff0a)
  // so all N transfers happen atomically or none do. Verified end-to-end in
  // the local node_modules copies of @tetherto/wdk-wallet-evm-erc-4337 and
  // abstractionkit (see memory/impl_erc4337_batch.md for the exact line
  // pointers).
  //
  // Docs cross-checked:
  //   https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
  //   https://eips.ethereum.org/EIPS/eip-4337
  //   https://eips.ethereum.org/EIPS/eip-20
  //
  // Input: recipientPairs = Array<{ address, amountAtomicUsdt }>
  //   - address: 0x + 20-byte hex, non-duplicate enforcement kept off (SDK
  //     will emit two Transfer events if the same address appears twice; that
  //     is a caller-side choice, not a wallet-layer error).
  //   - amountAtomicUsdt: positive integer STRING in USDT 6-decimal base units.
  //     Never a float (Curva forces base units at every boundary to avoid
  //     rounding bugs).
  //
  // Returns: { userOpHash, fee, recipientCount, totalAtomic }
  // ---------------------------------------------------------------------------
  async function signAndSendBatch(recipientPairs) {
    if (disposed) throw new WalletError('WALLET_DISPOSED', 'wallet disposed')
    if (!initialized) throw new WalletError('WALLET_NOT_INIT', 'wallet not initialized')
    if (!Array.isArray(recipientPairs)) {
      throw new WalletError('BATCH_SIZE_INVALID', 'recipientPairs must be an array')
    }
    if (recipientPairs.length < BATCH_MIN_RECIPIENTS || recipientPairs.length > BATCH_MAX_RECIPIENTS) {
      throw new WalletError(
        'BATCH_SIZE_INVALID',
        `recipientPairs.length must be ${BATCH_MIN_RECIPIENTS}..${BATCH_MAX_RECIPIENTS}`
      )
    }
    if (!deps.ethers || typeof deps.ethers.Interface !== 'function') {
      throw new WalletError('BATCH_NO_ETHERS', 'ethers.Interface not available')
    }
    if (typeof account?.sendTransaction !== 'function') {
      throw new WalletError('BATCH_UNSUPPORTED', 'account.sendTransaction not available on this WDK build')
    }

    const iface = new deps.ethers.Interface(ERC20_TRANSFER_ABI)
    let totalAtomic = 0n
    const txs = recipientPairs.map((pair, i) => {
      if (!pair || typeof pair !== 'object') {
        throw new WalletError('BATCH_INVALID_RECIPIENT', `recipientPairs[${i}] must be an object`)
      }
      const { address, amountAtomicUsdt } = pair
      if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new WalletError(
          'BATCH_INVALID_RECIPIENT',
          `recipientPairs[${i}].address must be 0x + 20-byte hex`
        )
      }
      // Positive integer decimal string. Explicitly disallow leading zeroes so
      // '01' cannot be conflated with the wire representation of a 1-atomic amount.
      if (typeof amountAtomicUsdt !== 'string' || !/^[1-9][0-9]*$/.test(amountAtomicUsdt)) {
        throw new WalletError(
          'BATCH_INVALID_AMOUNT',
          `recipientPairs[${i}].amountAtomicUsdt must be a positive integer string`
        )
      }
      const amt = BigInt(amountAtomicUsdt)
      totalAtomic += amt
      return {
        to: chain.usdtAddress,
        value: 0n,
        data: iface.encodeFunctionData('transfer', [address.toLowerCase(), amt])
      }
    })

    if (totalAtomic > BATCH_MAX_TOTAL_ATOMIC) {
      throw new WalletError(
        'BATCH_TOTAL_EXCEEDED',
        `batch total ${totalAtomic} atomic exceeds cap of ${BATCH_MAX_TOTAL_ATOMIC} atomic (15 USDT)`
      )
    }

    let result
    try {
      // WDK docs (fetched 2026-07-06) and the local source flatten [tx].flat()
      // so passing an array is a first-class code path. Return shape is
      // { hash: <userOp hash>, fee: bigint } identical to the single-tx path.
      result = await account.sendTransaction(txs)
    } catch (err) {
      const msg = err?.message || String(err)
      const balanceHit = /insufficient|balance/i.test(msg)
      const feeHit = /Exceeded maximum fee|transactionMaxFee/i.test(msg)
      const code = balanceHit
        ? 'BATCH_INSUFFICIENT_BALANCE'
        : feeHit
          ? 'BATCH_FEE_EXCEEDED'
          : 'BATCH_FAILED'
      throw new WalletError(code, `account.sendTransaction(batch) failed: ${msg}`)
    }

    if (!result || typeof result !== 'object') {
      throw new WalletError('BATCH_BAD_RESPONSE', 'account.sendTransaction returned no result')
    }
    const rawHash = result.hash
    if (typeof rawHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
      throw new WalletError('BATCH_BAD_RESPONSE', 'account.sendTransaction returned no valid hash')
    }
    const fee = typeof result.fee === 'bigint'
      ? result.fee.toString()
      : (result.fee != null ? String(result.fee) : null)

    return {
      userOpHash: rawHash.toLowerCase(),
      fee,
      recipientCount: txs.length,
      totalAtomic: totalAtomic.toString()
    }
  }

  // Pre-deploy warm: prime the WDK cache by reading address + balance.
  // Does NOT deploy the smart account — that costs gas and is unnecessary
  // for warming the cache. Safe to call multiple times.
  async function warmSmartAccount() {
    if (disposed || !initialized || !account) return { warmed: false }
    try {
      const addr = await account.getAddress()
      let bal = null
      if (typeof account.getTokenBalance === 'function') {
        try {
          const b = await account.getTokenBalance(chain.usdtAddress)
          bal = typeof b === 'bigint' ? b.toString() : String(b)
        } catch (err) {
          console.warn(LOG, 'warm: token balance fetch failed:', err.message)
        }
      }
      return { warmed: true, smartAddress: String(addr).toLowerCase(), tokenBalance: bal }
    } catch (err) {
      console.warn(LOG, 'warmSmartAccount failed:', err.message)
      return { warmed: false, error: err.message }
    }
  }

  function dispose() {
    disposed = true
    initialized = false
    account = null
    fallbackSigner = null
    // Clear the address caches too — no data at rest in this closure.
    smartAddress = null
    ownerAddress = null
    dynamicTokenName = null
    dynamicTokenVersion = null
  }

  return {
    init,
    signEip3009,
    signMessage,
    signAttendance,
    getInfo,
    getBalance,
    sendUsdtViaAccountTransfer,
    signAndSendBatch,
    warmSmartAccount,
    dispose,
    // Test-only helper — exposes NON-SECRET metadata for brittle tests.
    _testInternals: {
      chain,
      buildTypedData: (opts) => buildTypedData(opts)
    }
  }
}

// ---------------------------------------------------------------------------
// Seed load/create via wdk-secret-manager.
// ---------------------------------------------------------------------------
async function loadOrCreateSeed({ SecretManager, WDK, passcode, storageDir }) {
  if (!SecretManager) {
    throw new WalletError('WALLET_NO_SECRET_MANAGER', 'SecretManager not provided')
  }
  const secret = new SecretManager({ storage: storageDir, passcode })
  if (typeof secret.init === 'function') await secret.init()

  const SEED_KEY = 'curva.host.seed'

  let seed = null
  try {
    if (typeof secret.get === 'function') {
      seed = await secret.get(SEED_KEY)
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      seed = null
    } else if (err && /passcode|decrypt/i.test(err.message || '')) {
      throw new WalletError('WALLET_LOCKED', 'wrong passcode')
    } else {
      throw new WalletError('WALLET_SEED_LOAD', 'failed to load seed: ' + err.message)
    }
  }

  if (!seed) {
    // Generate a fresh 24-word seed. WDK.getRandomSeedPhrase uses Bare's crypto.
    if (!WDK || typeof WDK.getRandomSeedPhrase !== 'function') {
      throw new WalletError('WALLET_NO_WDK', 'WDK.getRandomSeedPhrase unavailable')
    }
    seed = WDK.getRandomSeedPhrase(24)
    if (typeof secret.set === 'function') {
      await secret.set(SEED_KEY, seed)
    }
    console.log(LOG, 'generated new seed (24 words); persisted encrypted')
  } else {
    console.log(LOG, 'loaded existing seed from encrypted store')
  }
  return seed
}

class WalletError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WalletError'
    this.code = code
  }
}

module.exports = {
  createWalletAdapter,
  WalletError,
  DEMO_AMOUNT_BASE_UNITS
}
