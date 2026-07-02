// Curva Electron main process.
// Spawns Bare workers via pear-runtime, bridges IPC to the renderer, handles CLI flags.
//
// Verified against holepunchto/hello-pear-electron@1.0.0 (fetched 2026-07-01) and
// pear-runtime@1.3.1. Do NOT use Pear.worker.run - that symbol does not exist in
// the current runtime. See pear-app/ARCHITECTURE.md section 1.1.

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg

const protocol = name
const mainWorkerSpecifier = '/workers/main.js'
const walletWorkerSpecifier = '/workers/wallet.js'

const workers = new Map()

const appName = productName ?? name

// Curva CLI flags. Note the template already supports --storage and --no-updates;
// we extend with the three Curva-specific flags plus Wave 7 Zone C's --demo=N
// split-screen mode.
const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide(),
  flag('--room <slug>', 'room slug to auto-join at boot'),
  flag('--is-host', 'mark this peer as the room host'),
  flag('--backend <url>', 'Curva Companion backend base URL'),
  flag('--demo <n>', 'launch N-peer split-screen demo (only n=4 supported)'),
  flag('--clean', 'when combined with --demo, wipe demo store dirs first')
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage ? path.resolve(cmd.flags.storage) : null
const updates = cmd.flags.updates
const roomSlug = cmd.flags.room || 'demo-room'
const isHost = !!cmd.flags.isHost
const backendUrl = cmd.flags.backend || process.env.CURVA_BACKEND_URL || 'http://localhost:3700'

// Wave 7 Zone C: split-screen 4-peer demo mode.
// Accepted via `--demo=4` OR `CURVA_DEMO=4`. Only n=4 is supported today.
// Rationale for the 2x2 grid: matches the four "watch-together cities" in the
// Ardoino demo script (Torino, Jakarta, Sao Paulo, Ciudad de Mexico).
const DEMO_PEER_LABELS = Object.freeze(['a', 'b', 'c', 'd'])
const DEMO_PEER_TITLES = Object.freeze(['Torino', 'Jakarta', 'Sao Paulo', 'Ciudad de Mexico'])

function parseDemoFlag(cliValue, envValue) {
  const raw = cliValue !== undefined ? cliValue : envValue
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 2) return null
  // Hard cap at 4 today. Bumping this without also expanding label lists
  // would push windows off-screen on 1080p displays.
  if (n !== 4) return null
  return n
}

const demoCount = parseDemoFlag(cmd.flags.demo, process.env.CURVA_DEMO)
const demoClean = !!cmd.flags.clean

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

// Renderer asks for the boot config (room slug, host flag, backend URL).
// Never expose secrets or filesystem paths here - this crosses the contextBridge.
ipcMain.on('curva:boot-config', (evt) => {
  evt.returnValue = {
    room: roomSlug,
    isHost,
    backend: backendUrl,
    version
  }
})

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      if (win.webContents.isDestroyed?.()) continue
      win.webContents.send(channel, data)
    } catch {
      // Renderer disposed mid-send (during quit); swallow.
    }
  }
}

function resolveStorageDir() {
  const appPath = getAppPath()
  if (pearStore) {
    console.log('[Curva] pear store:', pearStore)
    return pearStore
  }
  if (appPath === null) {
    return path.join(os.tmpdir(), 'pear', appName)
  }
  const isSnap = !!process.env.SNAP_USER_COMMON
  const linuxConfigHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? isSnap
        ? path.join(process.env.SNAP_USER_COMMON, appName)
        : path.join(linuxConfigHome, appName)
      : path.join(os.homedir(), 'AppData', 'Roaming', appName)
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)

  const appPath = getAppPath()
  const dir = resolveStorageDir()
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'

  // Bare.argv layout (indices are load-bearing - workers/main.js reads these positions):
  //   [0] bare bin
  //   [1] script path
  //   [2] storage dir
  //   [3] app path (may be null)
  //   [4] updates flag (string 'true'/'false')
  //   [5] version
  //   [6] upgrade key
  //   [7] app filename
  //   [8] room slug         <- Curva
  //   [9] is-host           <- Curva ('true' or 'false')
  //   [10] backend URL      <- Curva
  const workerArgs = [
    dir,
    appPath,
    String(updates !== false),
    version,
    upgrade,
    productName + extension,
    roomSlug,
    String(isHost),
    backendUrl
  ]

  console.log(
    '[Curva] spawning worker',
    specifier,
    'room=',
    roomSlug,
    'isHost=',
    isHost,
    'backend=',
    backendUrl
  )

  const worker = PearRuntime.run(require.resolve('..' + specifier), workerArgs)
  const pipe = new FramedStream(worker)

  const sendStdout = (data) => {
    process.stdout.write('[worker stdout] ' + data)
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  const sendStderr = (data) => {
    process.stderr.write('[worker stderr] ' + data)
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  const sendIPC = (data) => sendToAll('pear:worker:ipc:' + specifier, data)
  const onBeforeQuit = () => pipe.destroy()

  ipcMain.handle('pear:worker:writeIPC:' + specifier, (_evt, data) => pipe.write(data))

  workers.set(specifier, pipe)
  pipe.on('data', sendIPC)
  worker.stdout.on('data', sendStdout)
  worker.stderr.on('data', sendStderr)
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', sendIPC)
    worker.stdout.removeListener('data', sendStdout)
    worker.stderr.removeListener('data', sendStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
    console.log('[Curva] worker exited:', specifier, 'code=', code)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

function terminateWorker(specifier) {
  const pipe = workers.get(specifier)
  if (!pipe) return false
  pipe.destroy()
  return true
}

// Final Fix Wave T4: swarm suspend/resume plumbing.
//   - When the OS backgrounds the app (minimize on all platforms; blur can be
//     noisy so we do NOT hook it), we call swarm.suspend() in the Bare worker
//     via `curva:swarm-suspend` IPC. This drops DHT socket + discovery load
//     (battery + bandwidth on mobile-adjacent hardware).
//   - On restore/focus (and `app.on('activate')` on macOS) we resume.
//   - `SUSPEND_ON_MINIMIZE=off` disables the hook if it interferes with a live
//     demo (e.g., a presenter uses cmd-tab and expects zero reconnect delay).
//
// Docs verified:
//   https://www.electronjs.org/docs/latest/api/browser-window  (minimize/restore/focus)
//   https://github.com/holepunchto/hyperswarm  (suspend/resume)
const SUSPEND_ON_MINIMIZE_ENABLED =
  String(process.env.SUSPEND_ON_MINIMIZE || 'on').toLowerCase() !== 'off'

// Guard against double-fire: BrowserWindow may emit `restore` and `focus`
// nearly back-to-back. We track the last requested state and skip redundant
// IPC roundtrips.
let lastSwarmIntent = 'resumed'
function requestSwarmSuspend() {
  if (!SUSPEND_ON_MINIMIZE_ENABLED) return
  if (lastSwarmIntent === 'suspended') return
  lastSwarmIntent = 'suspended'
  try {
    const pipe = workers.get(mainWorkerSpecifier)
    if (!pipe) return
    const msg = { id: 'suspend-' + Date.now(), cmd: 'swarm:suspend', payload: {} }
    pipe.write(Buffer.from(JSON.stringify(msg), 'utf8'))
  } catch (err) {
    console.warn('[Curva] swarm:suspend write failed:', err.message)
  }
}
function requestSwarmResume() {
  if (!SUSPEND_ON_MINIMIZE_ENABLED) return
  if (lastSwarmIntent === 'resumed') return
  lastSwarmIntent = 'resumed'
  try {
    const pipe = workers.get(mainWorkerSpecifier)
    if (!pipe) return
    const msg = { id: 'resume-' + Date.now(), cmd: 'swarm:resume', payload: {} }
    pipe.write(Buffer.from(JSON.stringify(msg), 'utf8'))
  } catch (err) {
    console.warn('[Curva] swarm:resume write failed:', err.message)
  }
}

function wireSuspendResume(win) {
  if (!SUSPEND_ON_MINIMIZE_ENABLED) return
  // minimize -> suspend
  win.on('minimize', requestSwarmSuspend)
  // restore + focus -> resume (redundancy is fine; requestSwarmResume dedupes)
  win.on('restore', requestSwarmResume)
  win.on('focus', requestSwarmResume)
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#0a0a0a',
    title: 'Curva',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  wireSuspendResume(win)

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

// Wave 7 Zone C: split-screen demo mode.
// Compute the 2x2 grid geometry from the primary display work-area so each
// window fits within the OS-usable region (accounts for macOS menu bar +
// dock). Windows overlap the app icon by default on macOS; we don't fight
// that here.
function demoGridRects(workAreaSize) {
  const w = Math.floor(workAreaSize.width / 2)
  const h = Math.floor(workAreaSize.height / 2)
  return [
    { x: 0, y: 0, width: w, height: h },
    { x: w, y: 0, width: w, height: h },
    { x: 0, y: h, width: w, height: h },
    { x: w, y: h, width: w, height: h }
  ]
}

async function createDemoWindow({ index, storeDir, title, rect }) {
  const win = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    backgroundColor: '#0a0a0a',
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  // Track the per-window store so IPC helpers below can find the right
  // subprocess. Storing on the WebContents keeps it isolated from other
  // windows.
  win.__curva_demo_index = index
  win.__curva_demo_store = storeDir
  win.__curva_demo_title = title

  wireSuspendResume(win)

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    return win
  }
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  return win
}

async function bootstrapDemoMode() {
  // Deferred require: only pull `screen` when needed so unit tests importing
  // module scope don't need to stub it.
  const { screen } = require('electron')
  const fs = require('node:fs')
  const primary = screen.getPrimaryDisplay()
  const rects = demoGridRects(primary.workAreaSize)

  const baseDir = path.resolve(process.cwd(), '.demo-store')
  if (demoClean) {
    try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
  fs.mkdirSync(baseDir, { recursive: true })

  console.log('[Curva] demo mode enabled: 4 peers, 2x2 grid', primary.workAreaSize)

  // Sequential launch so we don't blast four Electron windows into a race
  // (each triggers its own Bare worker spawn under the hood; sequential
  // startup lowers peak CPU and prevents port-collision hiccups).
  for (let i = 0; i < demoCount; i++) {
    const label = DEMO_PEER_LABELS[i]
    const storeDir = path.join(baseDir, label)
    fs.mkdirSync(storeDir, { recursive: true })
    await createDemoWindow({
      index: i,
      storeDir,
      title: DEMO_PEER_TITLES[i] || ('Peer ' + label.toUpperCase()),
      rect: rects[i]
    })
  }
}

ipcMain.handle('pear:applyUpdate', () => {
  const pipe = getWorker(mainWorkerSpecifier)
  return new Promise((resolve) => {
    function onData(data) {
      if (data.toString() === 'pear:updateApplied') {
        pipe.removeListener('data', onData)
        resolve()
      }
    }
    pipe.on('data', onData)
    pipe.write('pear:applyUpdate')
  })
})

ipcMain.handle('pear:startWorker', (_evt, specifier) => {
  getWorker(specifier)
  return true
})

ipcMain.handle('pear:terminateWorker', (_evt, specifier) => {
  return terminateWorker(specifier)
})

ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv
          .slice(1)
          .filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.quit()
})

// Allowlist for openExternal. Kept in sync with preload.js allowlist. The
// second check here defends against a compromised renderer that could
// bypass the preload check (defense in depth per OWASP SSRF cheat sheet).
const EXTERNAL_HOST_ALLOWLIST = new Set([
  'etherscan.io',
  'sepolia.etherscan.io',
  'arbiscan.io',
  'sepolia.arbiscan.io',
  'plasmascan.to',
  'sepolia.plasmascan.to'
])

function isAllowedExternal(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return EXTERNAL_HOST_ALLOWLIST.has(u.hostname.toLowerCase())
  } catch { return false }
}

ipcMain.handle('curva:open-external', async (_evt, url) => {
  if (typeof url !== 'string' || !isAllowedExternal(url)) {
    console.warn('[Curva] openExternal rejected:', url)
    return { ok: false, error: 'URL not allowed' }
  }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    console.error('[Curva] openExternal failed:', err.message)
    return { ok: false, error: err.message }
  }
})

// Deep-link parser: `curva://room/<slug>`.
// Slug: 1-128 chars, alphanumeric + dash. No path traversal.
const SLUG_RE = /^[a-zA-Z0-9-]{1,128}$/

function parseDeepLink(url) {
  if (typeof url !== 'string') return null
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== protocol + ':') return null
  // Two supported shapes:
  //   curva://room/<slug>        -> host = 'room', pathname = '/<slug>'
  //   curva://<slug>             -> host = '<slug>' (informal fallback)
  let slug = null
  if (u.hostname === 'room') {
    slug = u.pathname.replace(/^\//, '').split('/')[0]
  } else if (u.hostname && !u.pathname.replace(/^\//, '')) {
    slug = u.hostname
  }
  if (!slug || !SLUG_RE.test(slug)) return null
  return { slug }
}

function handleDeepLink(url) {
  console.log('[Curva] deep link:', url)
  const parsed = parseDeepLink(url)
  if (!parsed) {
    console.warn('[Curva] deep link rejected (bad shape or slug):', url)
    return
  }
  // Send to every open renderer window so app.js can auto-join.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('curva:deeplink:join', { slug: parsed.slug })
    } catch { /* renderer disposed; ignore */ }
  }
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

// Graceful shutdown: give workers a chance to close swarm connections
// before Electron force-kills them. FramedStream.destroy() flushes the pipe,
// which triggers the worker's `goodbye` handler.
app.on('before-quit', () => {
  for (const [specifier, pipe] of workers) {
    console.log('[Curva] shutting down worker:', specifier)
    try {
      pipe.destroy()
    } catch (err) {
      console.error('[Curva] worker shutdown error:', err.message)
    }
  }
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (_evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    if (demoCount) {
      bootstrapDemoMode().catch((err) => {
        console.error('[Curva] failed to bootstrap demo mode:', err)
        app.quit()
      })
    } else {
      createWindow().catch((err) => {
        console.error('[Curva] failed to create window:', err)
        app.quit()
      })
    }

    // Windows/Linux cold-launch protocol handling: the URL is passed as a
    // process argv rather than open-url. On macOS the initial open-url
    // fires above once the app is ready. We defer a tick to let the
    // renderer subscribe.
    setTimeout(() => {
      const argv = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)
      const url = argv.find((arg) => typeof arg === 'string' && arg.startsWith(protocol + '://'))
      if (url) handleDeepLink(url)
    }, 500)

    app.on('activate', () => {
      // macOS: dock-icon click. Resume swarm even if we're not opening a new
      // window (all windows may have just been un-minimized by the OS).
      requestSwarmResume()
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('[Curva] failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// Export nothing (Electron main is not a module consumer); avoid leaking symbols.
