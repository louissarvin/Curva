# curva-mcp

Standalone MCP server that exposes Curva watch-party capabilities to Claude Desktop, Cursor, and any other MCP client. Wraps the Curva Companion backend (Fastify on Bun, default `http://localhost:3700`) plus a WDK ERC-4337 Sepolia wallet.

Built on top of `@tetherto/wdk-mcp-toolkit` (v1.0.0-beta.1) and `@modelcontextprotocol/sdk`.

## Tools

| Tool | Type | Backend endpoint | Elicitation |
|------|------|------------------|-------------|
| `join_watch_party` | read-only | `GET /rooms/:slug` | no |
| `send_tip` | value transfer | `POST /wdk/relay/eip3009` | yes |
| `open_prediction_pool` | signature only | `POST /predictions/open` | yes |
| `submit_prediction` | value transfer | `GET /predictions/pool/:room/:match`, `POST /predictions/entry` | yes |
| `pay_x402_resource` | value transfer | any `GET <url>` returning 402 | yes |
| `mint_attendance_pass` | signature only | (off-chain, no backend call at mint time) | yes |
| `verify_attendance_pass` | read-only | `GET /wdk/verify-attendance/:slug/:address` | no |

All value-transfer tools:

- Enforce per-session USDT ceilings (defaults: 25 tip, 10 stake, 1 x402/call).
- Run inputs through a prompt-injection guard.
- Trigger MCP elicitation via `server.server.elicitInput`. If the client does not support elicitation the tool refuses rather than auto-approving.
- Sign EIP-3009 with the owner EOA (not the Safe smart account), matching the pear-app signing model so the F11 facilitator can recover the signer.

## Resources

Alongside the mutating tools, the server exposes read-only MCP resources so agents can browse Curva state without invoking a tool. Resource URIs use [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) template syntax: `{var}` segments are substituted by the client at read time (Claude Desktop shows a variable form; the inspector fills them inline).

| URI | Kind | Backend call | Discovery |
|-----|------|--------------|-----------|
| `curva://rooms` | static | `GET /rooms?visibility=public` | listed automatically |
| `curva://rooms/{slug}` | template | `GET /rooms/:slug` | list + completion from `curva://rooms` |
| `curva://rooms/{slug}/roster` | template | `GET /rooms/:slug/roster` (or projected from `/rooms/:slug`) | none, follow a room |
| `curva://matches/live` | static | `GET /matches/today` | listed automatically |
| `curva://matches/{matchId}` | template | `GET /matches/:id` | list + completion from `curva://matches/live` |
| `curva://tips/{address}` | template | `GET /tips/:address` | none (address space is unbounded) |
| `curva://predictions/{poolId}` | template | `GET /predictions/pool/:poolId` | none, follow a room |
| `curva://attendance/{slug}/{address}` | template | stub (see below) | none |

All resource responses are `application/json`. On a backend failure the resource returns a JSON body of `{ error, note: "backend_unreachable" }` rather than throwing at the transport layer, so the client can surface the error inline.

The attendance resource is a stub: the underlying verify endpoint requires `signature`, `issuedAt`, and `matchId` query params which cannot be carried in a resource URI. Reading the resource returns a hint pointing at the `verify_attendance_pass` tool.

Example (with the inspector):

```bash
npx @modelcontextprotocol/inspector node src/index.js
# then in the Resources tab, read curva://rooms, or fill {slug} for curva://rooms/{slug}
```

Disable the whole resource surface with `CURVA_MCP_RESOURCES_ENABLED=false` (defaults to on). The nine tools stay wired regardless.

## Installation

```bash
cd mcp/curva-mcp
npm install
```

## Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `CURVA_MCP_WALLET_SEED` | yes | (BIP-39 mnemonic; never logged) |
| `CURVA_MCP_BACKEND_URL` | no | `http://localhost:3700` |
| `CURVA_MCP_CHAIN_ID` | no | `11155111` (Sepolia) |
| `CURVA_MCP_RPC_URL` | no | `https://ethereum-sepolia-rpc.publicnode.com` |
| `CURVA_MCP_BUNDLER_URL` | no | `https://api.candide.dev/public/v3/11155111` |
| `CURVA_MCP_PAYMASTER_URL` | no | `https://api.candide.dev/public/v3/11155111` |
| `CURVA_MCP_PAYMASTER_ADDRESS` | no | `0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba` |
| `CURVA_MCP_USDT_ADDRESS` | no | `0xd077a400968890eacc75cdc901f0356c943e4fdb` |
| `CURVA_MCP_TOKEN_NAME` | no | `USDT` |
| `CURVA_MCP_TOKEN_VERSION` | no | `1` |
| `CURVA_MCP_ON_CHAIN_ID` | no | `curva` |
| `CURVA_MCP_SESSION_TIP_CAP_USDT` | no | `25` |
| `CURVA_MCP_PER_CALL_TIP_CAP_USDT` | no | `15` |
| `CURVA_MCP_SESSION_STAKE_CAP_USDT` | no | `10` |
| `CURVA_MCP_PER_CALL_X402_CAP_USDT` | no | `1` |
| `CURVA_MCP_RED_FLAG_USDT` | no | `10` |
| `CURVA_MCP_RESOURCES_ENABLED` | no | `true` (set `false` to skip resource registration) |

The Curva Companion must run with these feature flags for the write-side tools to work end-to-end:

- `RELAY_SPONSOR_ENABLED=true` and a funded sponsor wallet (`send_tip`, `submit_prediction`, `pay_x402_resource`)
- `CURVA_PREDICTIONS_ENABLED=true` (`open_prediction_pool`, `submit_prediction`)
- `CURVA_X402_ENABLED=true` (`pay_x402_resource`)
- `CURVA_ATTENDANCE_ENABLED=true` (`verify_attendance_pass`)

## Local smoke test

```bash
export CURVA_MCP_WALLET_SEED="your twelve word bip39 mnemonic here"
export CURVA_MCP_BACKEND_URL="http://localhost:3700"
npm start
```

The server communicates on stdio. There is no stdout chatter — diagnostics go to stderr as one JSON object per line. To exercise a tool without a full MCP client, use the `@modelcontextprotocol/inspector`:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

## Claude Desktop configuration

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "curva-mcp": {
      "command": "node",
      "args": ["/Users/macbookair/Documents/curva/mcp/curva-mcp/src/index.js"],
      "env": {
        "CURVA_MCP_WALLET_SEED": "your twelve word bip39 mnemonic here",
        "CURVA_MCP_BACKEND_URL": "http://localhost:3700",
        "CURVA_MCP_CHAIN_ID": "11155111",
        "CURVA_MCP_RPC_URL": "https://ethereum-sepolia-rpc.publicnode.com",
        "CURVA_MCP_BUNDLER_URL": "https://api.candide.dev/public/v3/11155111"
      }
    }
  }
}
```

Restart Claude Desktop and confirm the `curva-mcp` server shows up under the model's Tools panel. Every write-side tool will render an in-chat approval dialog before signing.

## Sample prompts for judges

- "Look up the Curva room `demo-final-2026` and tell me who is hosting."
- "Join the `world-cup-final-2026` watch party, then tip the host 3 USDT with the note `Forza Azzurri`."
- "Fetch `http://localhost:3700/x402/premium-translations` and unlock it."
- "Open a winner-only prediction pool for room `ita-vs-arg-semi` on match `cmxxxxxxx` with deadline 2026-07-12T18:30:00Z."
- "Submit a 2 USDT stake on HOME in the pool for room `ita-vs-arg-semi` match `cmxxxxxxx`, peer handle `agent-01`."
- "Mint an attendance pass in room `demo-final-2026` for peer `0xabc...` and give me the verification URL."
- "Verify this attendance pass: room `demo-final-2026`, peer `0xabc...`, signature `0x...`, issuedAt `1720000000`."

## Security notes

- The wallet seed is only read at startup and lives in memory. `SIGINT`/`SIGTERM` calls `server.close()` so the WDK toolkit wipes key material per its docs.
- `src/safety.js` runs a prompt-injection regex over every tool argument before any signing or HTTP call. Reject-first is preferable to sanitization for signed authorizations.
- Every write-side tool checks a per-session USDT ceiling before it renders an elicitation dialog. If the ceiling is exceeded the tool fails without prompting.
- All logs go to stderr as JSON. stdout carries only the MCP transport.

## Docs referenced

- WDK MCP toolkit: `https://docs.wdk.tether.io/ai/mcp-toolkit/get-started/`
- WDK MCP API reference: `https://docs.wdk.tether.io/ai/mcp-toolkit/api-reference/`
- WDK ERC-4337 config: `https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/`
- WDK agent skills: `https://docs.wdk.tether.io/ai/agent-skills/`
- MCP elicitation spec: `https://modelcontextprotocol.io/docs/concepts/elicitation`
- MCP TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- x402 protocol: `https://x402.org/` and `https://docs.wdk.tether.io/ai/x402/`
