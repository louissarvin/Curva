#!/usr/bin/env bash
# Curva demo boot script: two Bare peers, HOME-isolated for clean QVAC file locks.
#
# Root cause of the flags below (verified 2026-07-11 debug session):
#   The QVAC SDK stores its registry corestore at $HOME/.qvac/registry-corestore/.
#   When two Bare peers share the same $HOME, they contend on the same flock and
#   throw "File descriptor could not be locked" on VLM/OCR/embed model loads.
#   HOME_A / HOME_B point each peer at its own storage dir. The shared model
#   files (~/.qvac/models/) are symlinked so we don't re-download the 500MB
#   SmolVLM2 per peer.
#
# Usage:
#   backend must already be running on http://localhost:3700
#   ./scripts/demo-boot-peers.sh
#
# Watches until both peers show `ready { ... }` in their logs, then prints the
# handles you can reference in the demo.

set -euo pipefail

PEAR_APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_A="/tmp/curva-peer-a-fresh"
HOME_B="/tmp/curva-peer-b-fresh"
LOG_A="/tmp/curva-peer-a.log"
LOG_B="/tmp/curva-peer-b.log"
BACKEND_URL="${CURVA_BACKEND_URL:-http://localhost:3700}"
SHARED_MODELS="${HOME}/.qvac/models"

echo "[demo-boot] killing any existing peers..."
pkill -9 -f "electron-forge.*curva-peer" 2>/dev/null || true
pkill -9 -f "curva-peer-[ab]-fresh" 2>/dev/null || true
sleep 2

echo "[demo-boot] preparing HOME-isolated storage..."
mkdir -p "${HOME_A}/.qvac" "${HOME_B}/.qvac"
mkdir -p "${SHARED_MODELS}"
# Symlink the shared model cache into each per-peer HOME so both peers hit the
# same downloaded gguf files without contending on the registry corestore.
ln -sfn "${SHARED_MODELS}" "${HOME_A}/.qvac/models"
ln -sfn "${SHARED_MODELS}" "${HOME_B}/.qvac/models"
# Remove Electron singleton locks from any prior crash.
rm -f "${HOME_A}/SingletonLock" "${HOME_A}/SingletonCookie" 2>/dev/null || true
rm -f "${HOME_B}/SingletonLock" "${HOME_B}/SingletonCookie" 2>/dev/null || true

# Feature flag set: all F1-F22 flags on so a judge can hit any demo path
# without knowing which env var toggles which behaviour.
CURVA_ENV=(
  # F4 semifinal: x402 paid-resource routes (premium translation + VIP room
  # reservation). Both peer worker AND backend must have this on; the
  # backend .env already ships with CURVA_X402_ENABLED=true. Without this,
  # the worker's vip:reserve handler returns FEATURE_DISABLED and the UI
  # shows "Reservation failed: x402 feature disabled".
  CURVA_X402_ENABLED=true
  CURVA_DEMO_MODE=true
  CURVA_FORCE_RELAY=1
  CURVA_KEET_IDENTITY_ENABLED=true
  CURVA_MULTIWRITER=true
  CURVA_BLIND_PEERING_ENABLED=true
  CURVA_APPLY_MIDDLEWARE_ENABLED=true
  CURVA_OBSERVABILITY_ENABLED=true
  CURVA_QVAC_COMMENTATOR_ENABLED=true
  CURVA_QVAC_STT_ENABLED=true
  CURVA_QVAC_TTS_ENABLED=true
  CURVA_QVAC_TTS_LOCALES=en,it,id,es,fr,de,pt
  CURVA_QVAC_LLM_TRANSLATE_ENABLED=true
  CURVA_QVAC_BOT_ENABLED=true
  CURVA_PREDICTIONS_ENABLED=true
  CURVA_ATTENDANCE_ENABLED=true
  CURVA_DELEGATED_INFERENCE_ENABLED=true
  CURVA_TACTICAL_ENABLED=true
  CURVA_DEMO_HUD_ENABLED=true
  CURVA_VOICE_CLONE_ENABLED=true
  CURVA_GOAL_CARD_ENABLED=true
  CURVA_GOAL_PIPELINE_ENABLED=true
  CURVA_LANGDETECT_ENABLED=true
  CURVA_SEMSEARCH_ENABLED=true
  CURVA_ASK_FRAME_ENABLED=true
  CURVA_DIARIZE_ENABLED=true
  CURVA_VLM_PREFILTER_ENABLED=true
  CURVA_VOICE_CLONE_GOAL_ENABLED=true
  CURVA_VOICE_COACH_MEMORY_ENABLED=true
  CURVA_MATCH_RECAP_ENABLED=true
  CURVA_COMMENTATOR_VOICE_CLONE_ENABLED=true
  CURVA_ROOM_SEARCH_ENABLED=true
  CURVA_AUTO_HIGHLIGHT_ENABLED=true
  CURVA_COMMENTATOR_RAG_ENABLED=true
  CURVA_QVAC_ASSET_SEED_ENABLED=true
  CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED=true
  CURVA_GOAL_PROOF_ENABLED=true
  CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED=true
)

echo "[demo-boot] booting Peer A (HOME=${HOME_A})..."
cd "${PEAR_APP_DIR}"

# QVAC SDK timeouts are primed programmatically inside bare/sdkPlugins.js via
# setSDKConfig() before any RPC verb fires. We do NOT use the file-based
# QVAC_CONFIG_PATH resolver because @qvac/sdk's Bare config loader (see
# node_modules/@qvac/sdk/dist/client/config-loader/resolve-config.bare.js:33)
# calls `require(filePath)` in an ESM context and throws
# CONFIG_FILE_PARSE_FAILED. See bare/sdkPlugins.js::primeSdkConfig for the
# programmatic-set path and the SDK internals it targets.

env "${CURVA_ENV[@]}" \
    HOME="${HOME_A}" \
    DEV_WALLET_PASSCODE=curva-peer-a-pw \
    CURVA_PROMETHEUS_PORT=4343 \
    nohup npx electron-forge start -- \
      --no-updates \
      --storage "${HOME_A}" \
      --no-auto-open \
      --backend "${BACKEND_URL}" \
    > "${LOG_A}" 2>&1 < /dev/null &
disown || true

sleep 1

echo "[demo-boot] booting Peer B (HOME=${HOME_B})..."
env "${CURVA_ENV[@]}" \
    HOME="${HOME_B}" \
    DEV_WALLET_PASSCODE=curva-peer-b-pw \
    CURVA_PROMETHEUS_PORT=4344 \
    nohup npx electron-forge start -- \
      --no-updates \
      --storage "${HOME_B}" \
      --no-auto-open \
      --backend "${BACKEND_URL}" \
    > "${LOG_B}" 2>&1 < /dev/null &
disown || true

echo "[demo-boot] waiting for peer A ready..."
until grep -q "ready {" "${LOG_A}" 2>/dev/null; do sleep 2; done
echo "[demo-boot] Peer A ready"

echo "[demo-boot] waiting for peer B ready..."
until grep -q "ready {" "${LOG_B}" 2>/dev/null; do sleep 2; done
echo "[demo-boot] Peer B ready"

# Auto-fund: peers generate a fresh 16-byte salt + 24-word BIP-39 seed on
# every boot per bare/wallet/worklet.js:695-702 (intentional demo choice
# that trades persistence for zero configuration). So every fresh boot
# needs re-funding before tips / VIP reservations can settle on-chain.
#
# This block waits for `wallet ready` in each peer log, greps the four
# addresses (Peer A owner+smart, Peer B owner+smart), and fires
# scripts/fund-peers.ts to seed 100 USDT into each from the sponsor EOA.
# Failing this step is non-fatal: peers still boot, chat still works, and
# only tips / VIP reservations will hit ERC20InsufficientBalance until the
# user runs the fund script by hand.
#
# Skip via SKIP_AUTOFUND=1 if the sponsor treasury is drained or you want
# to demo the ERC20InsufficientBalance error path deliberately.
echo "[demo-boot] waiting for peer wallets to initialize..."
until grep -q "wallet ready" "${LOG_A}" 2>/dev/null && grep -q "wallet ready" "${LOG_B}" 2>/dev/null; do
  sleep 2
done

PEER_A_OWNER=$(grep -A2 "wallet ready" "${LOG_A}" | grep "ownerAddress:" | head -1 | grep -oE "0x[a-fA-F0-9]{40}")
PEER_A_SMART=$(grep -A2 "wallet ready" "${LOG_A}" | grep "smartAddress:" | head -1 | grep -oE "0x[a-fA-F0-9]{40}")
PEER_B_OWNER=$(grep -A2 "wallet ready" "${LOG_B}" | grep "ownerAddress:" | head -1 | grep -oE "0x[a-fA-F0-9]{40}")
PEER_B_SMART=$(grep -A2 "wallet ready" "${LOG_B}" | grep "smartAddress:" | head -1 | grep -oE "0x[a-fA-F0-9]{40}")

if [ "${SKIP_AUTOFUND:-0}" = "1" ]; then
  echo "[demo-boot] SKIP_AUTOFUND=1 set, skipping fund step"
elif [ -n "${PEER_A_OWNER}" ] && [ -n "${PEER_A_SMART}" ] && [ -n "${PEER_B_OWNER}" ] && [ -n "${PEER_B_SMART}" ]; then
  echo "[demo-boot] auto-funding peer wallets (100 USDT each)..."
  cd "$(dirname "${PEAR_APP_DIR}")/backend" && bun run scripts/fund-peers.ts \
    "${PEER_A_OWNER}" "${PEER_A_SMART}" \
    "${PEER_B_OWNER}" "${PEER_B_SMART}" \
    --amount 100 2>&1 | tail -20 | sed 's/^/[fund] /' \
    || echo "[demo-boot] auto-fund failed (non-fatal). Run scripts/fund-peers.ts by hand if tips/VIP fail."
  cd "${PEAR_APP_DIR}"
else
  echo "[demo-boot] could not parse wallet addresses from logs; skipping fund step"
fi

echo ""
echo "==== BOOT SUMMARY ==================================================="
grep -E "sdkPlugins registered [0-9]|ready \{|handle:" "${LOG_A}" | head -3 | sed 's/^/[peer-A] /'
grep -E "sdkPlugins registered [0-9]|ready \{|handle:" "${LOG_B}" | head -3 | sed 's/^/[peer-B] /'
echo "[peer-A] wallet: owner=${PEER_A_OWNER:-?} smart=${PEER_A_SMART:-?}"
echo "[peer-B] wallet: owner=${PEER_B_OWNER:-?} smart=${PEER_B_SMART:-?}"
echo ""
echo "Logs: ${LOG_A}  |  ${LOG_B}"
echo "======================================================================"
echo ""
echo "Ready to demo. Publish a room from Peer A, join from Peer B."
