# Curva Contracts

**CurvaUSDT** is a USDT-branded EIP-3009 token deployed on Ethereum Sepolia. It powers Curva's gasless tipping path: peers sign `TransferWithAuthorization` off-chain, a funded facilitator submits the tx and pays the gas.

## Deployment (Sepolia)

| Field | Value |
|-------|-------|
| Token address | `0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739` |
| Etherscan | https://sepolia.etherscan.io/address/0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739 |
| Name | `Tether USD` |
| Symbol | `USDT` |
| Decimals | `6` |
| EIP-712 version | `1` |
| Owner / initial mint recipient | `0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58` (facilitator sponsor) |
| Sample gasless tx | https://sepolia.etherscan.io/tx/0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e |

The owner is also the Curva facilitator sponsor EOA. It holds ~1M USDT and 0.018 ETH so it can afford gas while relaying signed `transferWithAuthorization` calls from tipping peers.

## Source

- [`src/CurvaUSDT.sol`](./src/CurvaUSDT.sol) — the deployed contract. OpenZeppelin v5 base (`ERC20`, `Ownable`), plus a manual EIP-3009 implementation (`transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`) that matches Tether's mainnet USDT signature layout.
- [`CurvaUSDT.flat.sol`](./CurvaUSDT.flat.sol) — flattened build for Etherscan verification.

## Requirements

- Foundry (`forge`, `cast`) — install via `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Solidity `0.8.24` (pinned in `foundry.toml`)
- A funded Sepolia EOA for deployment

## Build

```bash
cd contracts
forge install
forge build
```

## Deploy a new instance

The Curva submission uses the address above. If a judge wants to reproduce the deployment:

```bash
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export SPONSOR_PK=0x<your-deployer-private-key>
export OWNER=0x<owner-address>   # will receive the initial mint

forge create src/CurvaUSDT.sol:CurvaUSDT \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $SPONSOR_PK \
  --constructor-args $OWNER
```

Constructor mints 1,000,000 USDT (with 6 decimals) to `$OWNER` and sets `$OWNER` as the contract owner.

## Verify on Etherscan

```bash
forge verify-contract \
  0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739 \
  src/CurvaUSDT.sol:CurvaUSDT \
  --chain sepolia \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58)
```

If verification via the compiler pipeline fails, submit the flattened source (`CurvaUSDT.flat.sol`) through the Etherscan UI.

## Tests

The `test/` directory is currently empty. `forge test` will pass with no failing suites but does not exercise the contract. The runtime behavior is verified end-to-end by the backend integration tests in [`../backend`](../backend) and the sample Sepolia tx above.

## Interacting with the deployed token

```bash
# Read the token metadata
cast call 0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739 "name()(string)" \
  --rpc-url $SEPOLIA_RPC_URL

# Check the sponsor balance
cast call 0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739 \
  "balanceOf(address)(uint256)" \
  0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58 \
  --rpc-url $SEPOLIA_RPC_URL
```

The full gasless tipping flow (peer signs, facilitator relays) is exposed by the backend at `POST /wdk/relay/eip3009` and the demo path at `POST /wdk/relay/demo-self-tip`. See [`../backend/README.md`](../backend/README.md).

## Security notes

- **Sepolia only.** Do NOT send mainnet funds to any address in this repo.
- The token grants `mint` to the owner. In production this would be renounced or replaced with a fixed supply; for the Cup submission it stays open so we can top up demo wallets.
- EIP-3009 nonces are single-use per `authorizer`; the contract rejects replays via the `_authorizationStates` mapping.

## References

- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [OpenZeppelin Contracts v5](https://docs.openzeppelin.com/contracts/5.x/)
- [Foundry Book](https://book.getfoundry.sh/)
