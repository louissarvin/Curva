// Wave 7 Zone C: demo-mode argv parser.
// Extracted from electron/main.js so it's importable from brittle tests
// without pulling in Electron globals. The parser is duplicated verbatim
// inside electron/main.js (see `parseDemoFlag`) so main.js has zero runtime
// dependency on this file. Keeping the code in one place (require here from
// main.js) would work but Electron's packaging step is easier to reason
// about when main.js is self-contained.

const DEMO_PEER_LABELS = Object.freeze(['a', 'b', 'c', 'd'])
const DEMO_PEER_TITLES = Object.freeze(['Torino', 'Jakarta', 'Sao Paulo', 'Ciudad de Mexico'])

/**
 * Return the desired peer count when demo mode is on, or null otherwise.
 * Only n=4 is accepted today (see main.js rationale).
 */
function parseDemoFlag(cliValue, envValue) {
  const raw = cliValue !== undefined && cliValue !== null && cliValue !== ''
    ? cliValue
    : envValue
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 2) return null
  if (n !== 4) return null
  return n
}

/**
 * 2x2 grid layout for the given work-area size.
 */
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

module.exports = {
  DEMO_PEER_LABELS,
  DEMO_PEER_TITLES,
  parseDemoFlag,
  demoGridRects
}
