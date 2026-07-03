// Runtime config for the renderer.
// Values here are safe to expose to the DOM. Never put secrets here.
//
// Precedence at boot:
//   1. `bridge.bootConfig()` (from --room / --is-host / --backend CLI flags)
//   2. Constants below
//
// The Bare worker gets the authoritative copy via Bare.argv, set in
// electron/main.js. The renderer copy is display-only.

export const BACKEND_URL = 'http://localhost:3700'
export const DEFAULT_ROOM = 'demo-room'

// Curva Sud palette (see styles.css).
export const THEME = {
  bg: '#0a0a0a',
  accent: '#8b0e2b', // vino rosso, Curva Sud
  accentDim: '#5c091c',
  text: '#e6e6e6',
  muted: '#7a7a7a'
}

// Renderer never reads env vars directly. Everything comes via bridge.bootConfig().
