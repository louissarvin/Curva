// pear-app/bare/assets.js
// Small helper to expose the pear.assets.branding drive path to workers/main.js
// so it can be forwarded to the renderer via IPC.
//
// Reads Pear.app.assets.branding.path when available, returns null otherwise.
// Never throws; always returns a safe result.
//
// Docs: https://docs.pears.com/reference/pear/api/ (Pear.app.assets[namespace])
// The runtime object shape is { link, ns, path, name, only, bytes }. `path` is
// an absolute on-disk path once the drive lands; before that, it may be
// undefined. Renderer must render a bundled fallback first, then re-render
// when `path` becomes truthy.

'use strict'

function getBrandingPath() {
  try {
    const p = (typeof globalThis.Pear === 'object' && globalThis.Pear) || null
    const assets = p && p.app && p.app.assets
    const branding = assets && assets.branding
    return (branding && typeof branding.path === 'string' && branding.path.length > 0)
      ? branding.path
      : null
  } catch {
    return null
  }
}

function getBrandingBytes() {
  try {
    const p = (typeof globalThis.Pear === 'object' && globalThis.Pear) || null
    const branding = p && p.app && p.app.assets && p.app.assets.branding
    return (branding && typeof branding.bytes === 'number') ? branding.bytes : null
  } catch {
    return null
  }
}

module.exports = { getBrandingPath, getBrandingBytes }
