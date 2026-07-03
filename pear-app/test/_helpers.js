// Shared test helpers.
// Phase 1 tests use a real Corestore backed by a fresh tmp directory per test,
// because there is no random-access-memory dep in the pear-app lockfile and
// Corestore does its own storage abstraction that expects a path.
//
// Each test MUST call `await cleanup()` in its teardown so the dir is removed.

const Corestore = require('corestore')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

let counter = 0

/**
 * Create a fresh Corestore inside os.tmpdir()/curva-test-<pid>-<n>.
 * @returns {{ store: Corestore, dir: string, cleanup: () => Promise<void> }}
 */
async function makeStore() {
  const dir = path.join(
    os.tmpdir(),
    `curva-test-${process.pid}-${Date.now()}-${counter++}`
  )
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  await store.ready()

  async function cleanup() {
    try { await store.close() } catch { /* noop */ }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* noop */ }
  }

  return { store, dir, cleanup }
}

module.exports = { makeStore }
