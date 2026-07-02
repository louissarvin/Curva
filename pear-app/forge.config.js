const path = require('path')

// Electron Forge config for Curva.
// Minimal Phase 0 setup: dmg (mac), deb + rpm + zip (linux/win fallback).
// MSIX/AppImage/Flatpak/Snap makers can be layered in Phase 5 for the release cut.

module.exports = {
  packagerConfig: {
    name: 'Curva',
    productName: 'Curva',
    icon: path.join(__dirname, 'assets', 'icon'),
    protocols: [
      {
        name: 'Curva',
        schemes: ['curva']
      }
    ],
    asar: true,
    // Prevents Electron from prompting for network access on first launch on macOS.
    extendInfo: {
      NSHumanReadableCopyright: 'Copyright (c) 2026 the Curva contributors'
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Curva',
        format: 'ULFO'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux']
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          maintainer: 'Curva contributors',
          homepage: 'https://curva.app'
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {}
    }
  ],
  plugins: [
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ],
  hooks: {}
}
