// Curva Wave 4 F1: Autobase apply() middleware chain.
//
// Docs-verification memo ---------------------------------------------------
//
// Ground truth (installed + published):
//   pear-app/node_modules/autobase/index.js — Autobase({apply}) is called by
//     the linearizer as `await handlers.apply(nodes, view, host)`. Verified
//     against docs.pears.com/reference/building-blocks/autobase/ (fetched
//     2026-07-10) and the reference README at
//     https://github.com/holepunchto/autobase.
//
//   The reducer contract is EXPLICIT:
//     1. apply MUST be pure with respect to `nodes` and `view` state; no
//        external globals, no network calls, no closure mutation that would
//        make replay/rebase produce different output.
//     2. Two peers replaying the same node stream through the same reducer
//        must arrive at identical `view` state.
//     3. The `host` argument exposes { addWriter, removeWriter, ackWriter,
//        interrupt(reason), removeable } — see
//        node_modules/autobase/index.js and README API section.
//
// Design goals:
//   - Compose cross-cutting concerns (audit log, chaos, system guard, replay
//     recorder) around ANY apply function without touching the underlying
//     reducer body.
//   - Preserve purity: middlewares are configured with pure options and
//     receive fresh state per call. No shared mutable closure state may leak
//     into the reducer path in a way that would break replay determinism.
//   - Middlewares that DO side-effect (audit sinks, ring buffers) must expose
//     their state through caller-supplied sinks so the reducer body remains a
//     pure function of (nodes, view).
//   - Each middleware MUST call `next(nodes, view, host)` exactly once; a
//     missing or double invocation throws `MiddlewareMustCallNext`.
//
// API:
//   composeApply([m1, m2, m3]) returns an apply(nodes, view, host) that runs:
//     m1(nodes, view, host, next=m2(..., next=m3(..., next=terminal)))
//   The terminal step is a no-op reducer; callers pass their real reducer as
//   the LAST middleware so it observes the (possibly filtered) node stream.
//
//   Factories exported:
//     auditLogMiddleware({ sink, sampleRate })
//     chaosMiddleware({ dropRate, env, seedSalt })
//     systemGuardMiddleware({ allowedTypes, maxNodeBytes })
//     replayRecorderMiddleware({ sink, maxSize })
//     terminalMiddleware(realApply)  -- wraps a legacy apply() as the tail
//
//   Each factory returns a middleware with signature:
//     async (nodes, view, host, next) => { /* pre */ await next(...) /* post */ }

'use strict'

class MiddlewareMustCallNext extends Error {
  constructor (message) {
    super(message || 'middleware must call next exactly once')
    this.name = 'MiddlewareMustCallNext'
    this.code = 'MW_MUST_CALL_NEXT'
  }
}

class InvalidMiddleware extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvalidMiddleware'
    this.code = 'MW_INVALID'
  }
}

/**
 * Compose a list of middlewares into a single Autobase apply() function.
 *
 * Middlewares run first-to-last: the first middleware is outermost, seeing
 * the raw node stream before any filter, and its `next` invokes the second,
 * and so on. The terminal step is a no-op unless callers include a terminal
 * wrapper as the last element.
 *
 * @param {Array<(nodes: any[], view: any, host: any, next: Function) => Promise<void>>} middlewares
 * @returns {(nodes: any[], view: any, host: any) => Promise<void>}
 */
function composeApply (middlewares) {
  if (!Array.isArray(middlewares)) {
    throw new InvalidMiddleware('composeApply requires an array of middlewares')
  }
  for (let i = 0; i < middlewares.length; i++) {
    if (typeof middlewares[i] !== 'function') {
      throw new InvalidMiddleware('middleware at index ' + i + ' is not a function')
    }
  }

  return async function composedApply (nodes, view, host) {
    const chain = middlewares.slice()
    let index = -1

    async function dispatch (i, n, v, h) {
      if (i <= index) {
        throw new MiddlewareMustCallNext('next() called multiple times at index ' + i)
      }
      index = i
      if (i >= chain.length) return
      const mw = chain[i]
      let called = 0
      const nextFn = async (nextNodes, nextView, nextHost) => {
        called += 1
        if (called > 1) {
          throw new MiddlewareMustCallNext('next() called multiple times inside middleware index ' + i)
        }
        return dispatch(i + 1, nextNodes !== undefined ? nextNodes : n,
          nextView !== undefined ? nextView : v,
          nextHost !== undefined ? nextHost : h)
      }
      await mw(n, v, h, nextFn)
      if (called === 0) {
        throw new MiddlewareMustCallNext('next() was not called inside middleware index ' + i)
      }
    }

    await dispatch(0, nodes, view, host)
  }
}

// -- Pure helpers -----------------------------------------------------------

// Deterministic 32-bit FNV-1a hash over the canonical JSON of a node value.
// The hash MUST be a pure function of the node payload so that two peers
// computing it on the same node arrive at the same 32-bit result. We JSON.
// stringify with sorted keys to eliminate object-key-ordering divergence.
function stableStringify (value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  const parts = new Array(keys.length)
  for (let i = 0; i < keys.length; i++) {
    parts[i] = JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]])
  }
  return '{' + parts.join(',') + '}'
}

function fnv1a32 (input) {
  const s = typeof input === 'string' ? input : stableStringify(input)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    // Multiplication mod 2^32 via bit-twiddling (JS numbers are floats).
    hash = (hash + ((hash << 1) >>> 0) + ((hash << 4) >>> 0) +
      ((hash << 7) >>> 0) + ((hash << 8) >>> 0) + ((hash << 24) >>> 0)) >>> 0
  }
  return hash >>> 0
}

// Env-flag parser shared across middlewares. Accepts truthy strings.
function envFlag (env, name) {
  if (!env || typeof env !== 'object') return false
  const raw = env[name]
  if (raw === undefined || raw === null) return false
  const s = String(raw).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

// -- Middleware factories ---------------------------------------------------

/**
 * Audit log middleware: emit a structured event per node to a caller-supplied
 * sink. The sink MUST NOT throw; failures are swallowed to preserve the
 * reducer contract. Sampling is deterministic based on the node hash.
 *
 * @param {{
 *   sink?: (event: object) => void,
 *   sampleRate?: number   // 0..1, fraction of nodes sampled; default 1 (all)
 * }} [opts]
 */
function auditLogMiddleware (opts = {}) {
  const sink = typeof opts.sink === 'function' ? opts.sink : () => {}
  const rateRaw = Number(opts.sampleRate)
  const sampleRate = Number.isFinite(rateRaw) ? Math.max(0, Math.min(1, rateRaw)) : 1
  const threshold = Math.floor(sampleRate * 0xFFFFFFFF)

  return async function auditLog (nodes, view, host, next) {
    if (Array.isArray(nodes) && sampleRate > 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const value = node && Object.prototype.hasOwnProperty.call(node, 'value')
          ? node.value : node
        const hash = fnv1a32(value)
        if (hash <= threshold) {
          try {
            sink({
              kind: 'audit',
              hash: hash >>> 0,
              type: value && typeof value === 'object' ? (value.type || null) : null,
              from: node && node.from && node.from.key
                ? bufferToHex(node.from.key).slice(0, 16) : null,
              at: 0 // deterministic: no wall-clock inside the reducer path
            })
          } catch { /* audit sinks must not break the reducer */ }
        }
      }
    }
    await next()
  }
}

/**
 * Chaos middleware: deterministically drops a fraction of nodes when the
 * chaos flag is enabled. The drop decision is a pure function of the node
 * hash, so every peer replaying the same node stream drops the same nodes.
 *
 * This preserves the reducer contract even though it filters nodes.
 *
 * @param {{
 *   dropRate?: number,   // 0..1, fraction dropped; default 0
 *   env?: object,        // env object to read CURVA_CHAOS_ENABLED from
 *   flagName?: string,   // override the env var name
 *   seedSalt?: string    // extra determinism salt so parallel middlewares differ
 * }} [opts]
 */
function chaosMiddleware (opts = {}) {
  const dropRate = Number.isFinite(Number(opts.dropRate))
    ? Math.max(0, Math.min(1, Number(opts.dropRate))) : 0
  const flagName = typeof opts.flagName === 'string' ? opts.flagName : 'CURVA_CHAOS_ENABLED'
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {})
  const enabled = envFlag(env, flagName)
  const threshold = Math.floor(dropRate * 0xFFFFFFFF)
  const salt = typeof opts.seedSalt === 'string' ? opts.seedSalt : 'curva/chaos'

  return async function chaos (nodes, view, host, next) {
    if (!enabled || dropRate === 0 || !Array.isArray(nodes)) {
      return next()
    }
    const kept = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const value = node && Object.prototype.hasOwnProperty.call(node, 'value')
        ? node.value : node
      // Deterministic hash: identical value + salt yields identical hash on
      // every peer, so chaos drops replay identically.
      const hash = fnv1a32(salt + '|' + stableStringify(value))
      if (hash > threshold) kept.push(node)
    }
    await next(kept)
  }
}

/**
 * System guard middleware: drops nodes whose shape is invalid. Validation is
 * pure: it inspects only the node value, never external state.
 *
 * @param {{
 *   allowedTypes?: string[] | null,   // null = allow any type field
 *   maxNodeBytes?: number             // reject nodes whose JSON exceeds this
 * }} [opts]
 */
function systemGuardMiddleware (opts = {}) {
  const allowed = Array.isArray(opts.allowedTypes)
    ? new Set(opts.allowedTypes.filter(t => typeof t === 'string'))
    : null
  const maxBytes = Number.isFinite(Number(opts.maxNodeBytes))
    ? Math.max(0, Number(opts.maxNodeBytes)) : 0

  return async function systemGuard (nodes, view, host, next) {
    if (!Array.isArray(nodes)) return next()
    const kept = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node || typeof node !== 'object') continue
      const value = Object.prototype.hasOwnProperty.call(node, 'value')
        ? node.value : node
      // Non-object payloads are always dropped by the guard: chat.js's real
      // apply already expects object values (see chat.js:243 `const v =
      // node.value`).
      if (!value || typeof value !== 'object') continue
      if (allowed) {
        const t = typeof value.type === 'string' ? value.type : null
        // Autobase control blocks (`addWriter`, `removeWriter`) are permitted
        // regardless of the allowlist because they are typeless.
        const isControl = !!(value.addWriter || value.removeWriter)
        if (!isControl && (!t || !allowed.has(t))) continue
      }
      if (maxBytes > 0) {
        const serialized = stableStringify(value)
        if (serialized.length > maxBytes) continue
      }
      kept.push(node)
    }
    await next(kept)
  }
}

/**
 * Replay recorder middleware: pushes each node into a caller-supplied ring
 * sink for post-mortem inspection. The ring lives OUTSIDE the reducer body
 * (in the caller) so replay determinism is preserved: the ring is a side
 * observation, not a reducer input.
 *
 * @param {{
 *   sink?: (entry: object) => void,
 *   maxSize?: number
 * }} [opts]
 */
function replayRecorderMiddleware (opts = {}) {
  const sink = typeof opts.sink === 'function' ? opts.sink : () => {}
  const maxSize = Number.isFinite(Number(opts.maxSize)) && opts.maxSize > 0
    ? Math.floor(opts.maxSize) : 1024
  let recorded = 0

  return async function replayRecorder (nodes, view, host, next) {
    if (Array.isArray(nodes)) {
      for (let i = 0; i < nodes.length && recorded < maxSize; i++) {
        const node = nodes[i]
        const value = node && Object.prototype.hasOwnProperty.call(node, 'value')
          ? node.value : node
        try {
          sink({
            index: recorded,
            hash: fnv1a32(value),
            valueType: value && typeof value === 'object' ? (value.type || null) : null
          })
          recorded += 1
        } catch { /* sink failures must not break the reducer */ }
      }
    }
    await next()
  }
}

/**
 * Wrap a legacy apply(nodes, view, host) as a terminal middleware. Callers
 * append this to the middleware list so the real reducer runs after all the
 * pre-hooks.
 *
 * @param {(nodes: any[], view: any, host: any) => Promise<void>} realApply
 */
function terminalMiddleware (realApply) {
  if (typeof realApply !== 'function') {
    throw new InvalidMiddleware('terminalMiddleware requires an apply function')
  }
  return async function terminal (nodes, view, host, next) {
    await realApply(nodes, view, host)
    await next()
  }
}

function bufferToHex (buf) {
  if (!buf) return ''
  if (typeof buf === 'string') return buf
  if (typeof buf.toString === 'function') {
    try { return buf.toString('hex') } catch { /* fall through */ }
  }
  return ''
}

module.exports = {
  composeApply,
  auditLogMiddleware,
  chaosMiddleware,
  systemGuardMiddleware,
  replayRecorderMiddleware,
  terminalMiddleware,
  MiddlewareMustCallNext,
  InvalidMiddleware,
  _internal: {
    stableStringify,
    fnv1a32,
    envFlag
  }
}
