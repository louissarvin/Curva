#!/usr/bin/env bash
# Manual verification for the 8 MCP resources exposed by curva-mcp.
#
# The stdio MCP server does not speak HTTP directly. To exercise it over JSON-RPC
# without wiring a full client, we use the @modelcontextprotocol/inspector's
# stdio bridge, or drive the process through a here-doc.
#
# This script uses the second approach: spawn the server on stdio, pipe a series
# of JSON-RPC frames, and grep the output for the expected resource URIs and
# read results.
#
# Prerequisites:
#   - the Curva Companion backend running on ${CURVA_MCP_BACKEND_URL:-http://localhost:3700}
#   - CURVA_MCP_WALLET_SEED exported in the environment
#   - node 20+
#
# Usage:
#   bash test-resources.sh
#
# Optional overrides:
#   ROOM_SLUG=demo-final-2026 MATCH_ID=abc123 ADDRESS=0xabc POOL_ID=pool-1 bash test-resources.sh

set -euo pipefail

if [[ -z "${CURVA_MCP_WALLET_SEED:-}" ]]; then
  echo "CURVA_MCP_WALLET_SEED is not set. Export a BIP-39 mnemonic first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ENTRY="$SCRIPT_DIR/src/index.js"

ROOM_SLUG="${ROOM_SLUG:-demo-final-2026}"
MATCH_ID="${MATCH_ID:-match-demo-final}"
ADDRESS="${ADDRESS:-0x0000000000000000000000000000000000000001}"
POOL_ID="${POOL_ID:-pool-demo}"

if [[ ! -f "$SERVER_ENTRY" ]]; then
  echo "Cannot find server entry at $SERVER_ENTRY" >&2
  exit 1
fi

# Build a JSON-RPC batch. The MCP handshake requires initialize first, then we
# list resources and templates, then read each one. Frames are line-delimited
# JSON per the stdio transport spec.
build_input() {
  cat <<'JSONRPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curva-mcp-test","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"resources/templates/list","params":{}}
{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"curva://rooms"}}
{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"curva://matches/live"}}
JSONRPC
  # Templated reads. Injected via shell variables so the caller can override.
  printf '{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"curva://rooms/%s"}}\n' "$ROOM_SLUG"
  printf '{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"curva://rooms/%s/roster"}}\n' "$ROOM_SLUG"
  printf '{"jsonrpc":"2.0","id":8,"method":"resources/read","params":{"uri":"curva://matches/%s"}}\n' "$MATCH_ID"
  printf '{"jsonrpc":"2.0","id":9,"method":"resources/read","params":{"uri":"curva://tips/%s"}}\n' "$ADDRESS"
  printf '{"jsonrpc":"2.0","id":10,"method":"resources/read","params":{"uri":"curva://predictions/%s"}}\n' "$POOL_ID"
  printf '{"jsonrpc":"2.0","id":11,"method":"resources/read","params":{"uri":"curva://attendance/%s/%s"}}\n' "$ROOM_SLUG" "$ADDRESS"
}

# Feed the frames into the server and capture stdout responses. stderr carries
# the server's structured logs; we redirect it to a temp file so the summary
# prints cleanly.
STDERR_LOG="$(mktemp -t curva-mcp-test-stderr.XXXXXX)"
trap 'rm -f "$STDERR_LOG"' EXIT

echo "Spawning $SERVER_ENTRY"
RESPONSES="$(build_input | node "$SERVER_ENTRY" 2>"$STDERR_LOG" || true)"

echo
echo "----- Responses -----"
echo "$RESPONSES"
echo
echo "----- Stderr (server logs) -----"
cat "$STDERR_LOG"
echo

# Basic assertions. We look for each resource URI in a resources/read response.
EXPECTED_URIS=(
  "curva://rooms"
  "curva://matches/live"
  "curva://rooms/$ROOM_SLUG"
  "curva://rooms/$ROOM_SLUG/roster"
  "curva://matches/$MATCH_ID"
  "curva://tips/$ADDRESS"
  "curva://predictions/$POOL_ID"
  "curva://attendance/$ROOM_SLUG/$ADDRESS"
)

FAILED=0
for uri in "${EXPECTED_URIS[@]}"; do
  if echo "$RESPONSES" | grep -q "\"$uri\""; then
    echo "OK   $uri"
  else
    echo "FAIL $uri (no response frame mentioned this URI)"
    FAILED=1
  fi
done

exit "$FAILED"
