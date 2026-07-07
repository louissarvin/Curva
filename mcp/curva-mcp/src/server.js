// WdkMcpServer wiring for Curva. Constructor and useWdk/registerWallet chain
// verified against https://docs.wdk.tether.io/ai/mcp-toolkit/get-started/ and
// https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/.

import { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit';
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337';
import { CONFIG } from './config.js';
import { logJson } from './safety.js';
import { registerJoinWatchParty } from './tools/joinWatchParty.js';
import { registerSendTip } from './tools/sendTip.js';
import { registerTipBatch } from './tools/tipBatch.js';
import { registerOpenPredictionPool } from './tools/openPredictionPool.js';
import { registerSubmitPrediction } from './tools/submitPrediction.js';
import { registerPayX402Resource } from './tools/payX402Resource.js';
import { registerMintAttendancePass } from './tools/mintAttendancePass.js';
import { registerVerifyAttendancePass } from './tools/verifyAttendancePass.js';
import { registerVerifyTipAttribution } from './tools/verifyTipAttribution.js';
import {
  registerRoomsListResource,
  registerRoomDetailResource,
  registerRoomRosterResource,
  registerMatchesLiveResource,
  registerMatchDetailResource,
  registerTipsResource,
  registerPredictionsResource,
  registerAttendanceResource,
} from './resources/index.js';

// Feature flag: default ON. Set CURVA_MCP_RESOURCES_ENABLED=false to skip
// resource registration entirely (rollback lever, keeps the 9 tools intact).
const RESOURCES_ENABLED = process.env.CURVA_MCP_RESOURCES_ENABLED !== 'false';

export async function buildServer() {
  const server = new WdkMcpServer('curva-mcp', '0.1.0');

  // useWdk + registerWallet is the docs-verified bootstrap. We do NOT chain
  // .registerTools([...WALLET_TOOLS]) because Curva ships a tight capability
  // surface; agents that need raw WDK wallet ops should use the base wdk MCP.
  server
    .useWdk({ seed: CONFIG.seed })
    .registerWallet('ethereum', WalletManagerEvmErc4337, {
      chainId: CONFIG.chainId,
      provider: CONFIG.provider,
      bundlerUrl: CONFIG.bundlerUrl,
      paymasterUrl: CONFIG.paymasterUrl,
      paymasterAddress: CONFIG.paymasterAddress,
      safeModulesVersion: '0.3.0',
      paymasterToken: { address: CONFIG.usdtAddress },
      onChainIdentifier: CONFIG.onChainIdentifier,
    });

  // registerTools accepts an array of (server) => void functions per the docs
  // (https://docs.wdk.tether.io/ai/mcp-toolkit/api-reference/). Each register*
  // function calls server.registerTool(name, config, handler) internally on
  // the McpServer that WdkMcpServer extends.
  server.registerTools([
    registerJoinWatchParty,
    registerSendTip,
    registerTipBatch,
    registerOpenPredictionPool,
    registerSubmitPrediction,
    registerPayX402Resource,
    registerMintAttendancePass,
    registerVerifyAttendancePass,
    registerVerifyTipAttribution,
  ]);

  // WdkMcpServer extends McpServer (docs.wdk.tether.io/ai/mcp-toolkit/ says
  // "Extends the official @modelcontextprotocol/sdk McpServer"), so
  // registerResource is inherited on the same instance. No wrapper needed.
  if (RESOURCES_ENABLED) {
    registerRoomsListResource(server);
    registerRoomDetailResource(server);
    registerRoomRosterResource(server);
    registerMatchesLiveResource(server);
    registerMatchDetailResource(server);
    registerTipsResource(server);
    registerPredictionsResource(server);
    registerAttendanceResource(server);

    logJson('info', 'server.resources_registered', {
      resources: [
        'curva://rooms',
        'curva://rooms/{slug}',
        'curva://rooms/{slug}/roster',
        'curva://matches/live',
        'curva://matches/{matchId}',
        'curva://tips/{address}',
        'curva://predictions/{poolId}',
        'curva://attendance/{slug}/{address}',
      ],
    });
  }

  logJson('info', 'server.built', {
    name: 'curva-mcp',
    version: '0.1.0',
    chainId: CONFIG.chainId,
    backend: CONFIG.backendBaseUrl,
    tools: [
      'join_watch_party',
      'send_tip',
      'tip_batch',
      'open_prediction_pool',
      'submit_prediction',
      'pay_x402_resource',
      'mint_attendance_pass',
      'verify_attendance_pass',
      'verify_tip_attribution',
    ],
  });

  return server;
}
