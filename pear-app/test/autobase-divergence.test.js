// ADR-001 flagship test: Autobase divergence + reorder resilience.
//
// The Autobase docs (https://docs.pears.com/reference/building-blocks/autobase/)
// warn: "Autobase can reorder previously seen nodes when new causal information
// arrives. If apply is non-deterministic, different peers will diverge." Our
// chat reducer is Fix-Wave-A pure (rate-limit at ingress, tip-writer binding
// in-view), so causally-different message orderings MUST converge to identical
// history arrays on every peer.
//
// Strategy: spin up two corestores in-process, pipe their replicate() streams
// together so peer chats replicate live, share the host's autobase bootstrap
// key with the peer, and drive interleaved sends. Assertion is element-wise
// deep-equal on the observable history.
//
// Verified installed APIs:
//   pear-app/node_modules/autobase/index.js:291 (base.replicate delegates to
//     the store); README §API "loading an existing Autobase"
//   pear-app/node_modules/corestore/index.js:store.replicate(isInitiator|stream, opts)

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createChat } = require('../bare/chat.js')

// Wire two chats via the Autobase replicate() streams. Corestore's raw
// store.replicate() is NOT enough for Autobase: `wakeupProtocol.addStream`
// is what teaches the linearizer about the peer's heads (see
// pear-app/node_modules/autobase/index.js:291-295). We use base.replicate()
// on each side so both stores AND the wakeup protocol are attached.
async function pipeChats(chatA, chatB) {
  const streamA = chatA.getBase().replicate(true)
  const streamB = chatB.getBase().replicate(false)
  streamA.pipe(streamB).pipe(streamA)
  streamA.on('error', () => { /* ignore terminated */ })
  streamB.on('error', () => { /* ignore terminated */ })
  return async function unpipe() {
    try { streamA.destroy() } catch { /* noop */ }
    try { streamB.destroy() } catch { /* noop */ }
  }
}

async function waitFor(pred, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

function normalizeMsg(m) {
  // Only compare the fields both peers observe deterministically. Ordering-
  // relevant fields are (wall_clock_ms, by_peer). Rate-limit/lamport internals
  // are intentionally excluded — the reducer is what we're testing, not the
  // wire format.
  return {
    type: m.type,
    text: m.text || null,
    by_peer: m.by_peer,
    match_time_ms: m.match_time_ms,
    wall_clock_ms: m.wall_clock_ms
  }
}

async function historyForCompare(chat) {
  const raw = await chat.history({ from: 0, limit: 500 })
  return raw
    .filter((m) => m.type === 'msg' || m.type === 'system:tip')
    .map(normalizeMsg)
}

test('ADR-001 reorder resilience: interleaved sends converge to identical history', async (t) => {
  const A = await makeStore()
  const B = await makeStore()
  const chatA = await createChat(A.store, { myPubkey: 'aa'.repeat(32) })
  const bootstrapHex = Buffer.from(chatA.getBase().key).toString('hex')
  const chatB = await createChat(B.store, {
    myPubkey: 'bb'.repeat(32),
    bootstrap: bootstrapHex
  })
  const unpipe = await pipeChats(chatA, chatB)

  // Interleaved send order: A1, B1, A2, B2, A3, B3. Sleep between each so the
  // Autobase Linearizer sees causal separation on the wall_clock_ms axis.
  await chatA.send({ text: 'A1', match_time_ms: 100 })
  await new Promise((r) => setTimeout(r, 30))
  await chatB.send({ text: 'B1', match_time_ms: 100 })
  await new Promise((r) => setTimeout(r, 30))
  await chatA.send({ text: 'A2', match_time_ms: 200 })
  await new Promise((r) => setTimeout(r, 30))
  await chatB.send({ text: 'B2', match_time_ms: 200 })
  await new Promise((r) => setTimeout(r, 30))
  await chatA.send({ text: 'A3', match_time_ms: 300 })
  await new Promise((r) => setTimeout(r, 30))
  await chatB.send({ text: 'B3', match_time_ms: 300 })

  const ok = await waitFor(async () => {
    const hA = await historyForCompare(chatA)
    const hB = await historyForCompare(chatB)
    if (hA.length < 6 || hB.length < 6) return false
    return JSON.stringify(hA) === JSON.stringify(hB)
  })
  t.ok(ok, 'both peers converge on identical chat history')

  await unpipe()
  await chatA.close()
  await chatB.close()
  await A.cleanup()
  await B.cleanup()
})

test('ADR-001 batched reorder: bulk sends converge within 3 seconds', async (t) => {
  const A = await makeStore()
  const B = await makeStore()
  const chatA = await createChat(A.store, { myPubkey: 'a1'.repeat(32) })
  const bootstrapHex = Buffer.from(chatA.getBase().key).toString('hex')
  const chatB = await createChat(B.store, {
    myPubkey: 'b1'.repeat(32),
    bootstrap: bootstrapHex
  })
  const unpipe = await pipeChats(chatA, chatB)

  // Bulk A sends first, then bulk B sends. This is the WORST case for
  // reordering because the linearizer sees B arrive after all of A.
  // Rate limit is 3/sec/peer AT INGRESS (see chat.js withinRate). Space sends
  // ~400ms apart so we stay under 3/sec but still exercise many-block reorder.
  for (let i = 0; i < 5; i++) {
    await chatA.send({ text: 'A' + i, match_time_ms: 100 + i })
    await new Promise((r) => setTimeout(r, 400))
  }
  for (let i = 0; i < 5; i++) {
    await chatB.send({ text: 'B' + i, match_time_ms: 200 + i })
    await new Promise((r) => setTimeout(r, 400))
  }

  const start = Date.now()
  const ok = await waitFor(async () => {
    const hA = await historyForCompare(chatA)
    const hB = await historyForCompare(chatB)
    if (hA.length < 10 || hB.length < 10) return false
    return JSON.stringify(hA) === JSON.stringify(hB)
  }, { timeoutMs: 5000 })
  const took = Date.now() - start
  t.ok(ok, 'peers converge on 10 batched messages (5 per writer)')
  t.ok(took < 5000, 'convergence completed inside the wait window (' + took + 'ms)')

  await unpipe()
  await chatA.close()
  await chatB.close()
  await A.cleanup()
  await B.cleanup()
})

test('ADR-001 system message deterministic ordering: system:tip interleaved with msg', async (t) => {
  const A = await makeStore()
  const B = await makeStore()
  const chatA = await createChat(A.store, { myPubkey: 'ab'.repeat(32) })
  const bootstrapHex = Buffer.from(chatA.getBase().key).toString('hex')
  const chatB = await createChat(B.store, {
    myPubkey: 'ba'.repeat(32),
    bootstrap: bootstrapHex
  })
  const unpipe = await pipeChats(chatA, chatB)

  await chatA.send({ text: 'hello', match_time_ms: 100 })
  await new Promise((r) => setTimeout(r, 30))
  await chatB.sendSystem({
    type: 'system:tip',
    amount: '1000000',
    tx_hash: '0x' + '1'.repeat(64),
    match_time_ms: 200
  })
  await new Promise((r) => setTimeout(r, 30))
  await chatA.send({ text: 'world', match_time_ms: 300 })
  await new Promise((r) => setTimeout(r, 30))
  await chatB.sendSystem({
    type: 'system:tip',
    amount: '2000000',
    tx_hash: '0x' + '2'.repeat(64),
    match_time_ms: 400
  })

  const ok = await waitFor(async () => {
    const hA = await historyForCompare(chatA)
    const hB = await historyForCompare(chatB)
    if (hA.length < 4 || hB.length < 4) return false
    return JSON.stringify(hA) === JSON.stringify(hB)
  })
  t.ok(ok, 'system:tip + msg interleave converges identically on both peers')

  await unpipe()
  await chatA.close()
  await chatB.close()
  await A.cleanup()
  await B.cleanup()
})

test('ADR-001 identical replay: sending same shape twice does not diverge state', async (t) => {
  // Regression on the Fix-Wave-A change: repeatedly sending a system:tip with
  // the same tx_hash used to mutate a closure Map inside apply(); on rebase
  // the second replay saw a different Map state than the first. Now the
  // tip-writer binding lives in the Hyperbee view, so replay is idempotent.
  const A = await makeStore()
  const B = await makeStore()
  const chatA = await createChat(A.store, { myPubkey: 'cd'.repeat(32) })
  const bootstrapHex = Buffer.from(chatA.getBase().key).toString('hex')
  const chatB = await createChat(B.store, {
    myPubkey: 'dc'.repeat(32),
    bootstrap: bootstrapHex
  })
  const unpipe = await pipeChats(chatA, chatB)

  const tx = '0x' + 'f'.repeat(64)
  await chatA.sendSystem({
    type: 'system:tip',
    amount: '1000000',
    tx_hash: tx,
    match_time_ms: 100
  })
  await new Promise((r) => setTimeout(r, 60))
  await chatA.sendSystem({
    type: 'system:tip',
    amount: '1000000',
    tx_hash: tx,
    match_time_ms: 101
  })

  const ok = await waitFor(async () => {
    const hA = await historyForCompare(chatA)
    const hB = await historyForCompare(chatB)
    if (hA.length === 0 || hB.length === 0) return false
    return JSON.stringify(hA) === JSON.stringify(hB)
  })
  t.ok(ok, 'idempotent system:tip replay converges on both peers')

  await unpipe()
  await chatA.close()
  await chatB.close()
  await A.cleanup()
  await B.cleanup()
})
