// Final Fix Wave T4: swarm suspend/resume dispatcher.
//
// Extracted from workers/main.js so it can be unit-tested without booting the
// full Bare worker (which needs Pear/Bare globals). The worker imports these
// helpers and wires them into its IPC case dispatch.
//
// Docs verified:
//   https://github.com/holepunchto/hyperswarm  (suspend / resume)

/**
 * Call `swarm.suspend()` and return a serializable result envelope.
 * Never throws — errors are captured and surfaced on the envelope so the
 * caller can emit them over IPC without crashing the reducer.
 *
 * @param {{ suspend?: Function }} swarm
 * @returns {Promise<{ ok: boolean, note?: string, error?: string }>}
 */
async function suspendSwarm(swarm) {
  if (!swarm || typeof swarm.suspend !== 'function') {
    return { ok: true, note: 'suspend-not-supported' }
  }
  try {
    await swarm.suspend()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * Call `swarm.resume()` and return a serializable result envelope.
 * @param {{ resume?: Function }} swarm
 * @returns {Promise<{ ok: boolean, note?: string, error?: string }>}
 */
async function resumeSwarm(swarm) {
  if (!swarm || typeof swarm.resume !== 'function') {
    return { ok: true, note: 'resume-not-supported' }
  }
  try {
    await swarm.resume()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

module.exports = { suspendSwarm, resumeSwarm }
