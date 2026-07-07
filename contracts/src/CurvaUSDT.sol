// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CurvaUSDT
/// @notice Minimal Tether USD (USDT) test token for Curva's Tether Developers Cup 2026 hackathon.
///         Renders as "Tether USD" / "USDT" / 6 decimals on Etherscan and implements EIP-3009
///         `transferWithAuthorization` so Curva's gasless-tip facilitator can produce real
///         `AuthorizationUsed` events on Sepolia.
/// @dev NOT a real Tether asset — deployed to Sepolia testnet solely for hackathon demo.
contract CurvaUSDT is ERC20, EIP712, Ownable {
    /// @notice EIP-3009 TransferWithAuthorization struct typehash
    /// @dev keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    /// @notice Tracks used authorization nonces per authorizer
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    /// @notice Emitted when an authorization has been used
    /// @param authorizer The address that signed the authorization
    /// @param nonce      The unique nonce for the authorization
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    // --- Errors ---
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();

    /// @param initialOwner Address that owns the mint capability and receives control.
    constructor(address initialOwner)
        ERC20("Tether USD", "USDT")
        EIP712("Tether USD", "1")
        Ownable(initialOwner)
    {}

    /// @notice USDT is a 6-decimal asset. Override the default 18-decimal ERC20 behavior.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice EIP-712 domain version. Curva's facilitator reads this via `contract.version()`
    ///         to construct the typed-data domain separator.
    function version() public pure returns (string memory) {
        return "1";
    }

    /// @notice Returns true if the authorization nonce has already been used by `authorizer`.
    /// @param authorizer Address that signed the authorization
    /// @param nonce      Unique authorization nonce
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice Executes a transfer with a signed EIP-3009 authorization.
    /// @dev Follows the EIP-3009 spec exactly:
    ///      - `block.timestamp > validAfter` (strict)
    ///      - `block.timestamp < validBefore` (strict)
    ///      - nonce must not have been used by `from`
    ///      - signature must recover to `from`
    ///      Marks the nonce as used BEFORE the transfer (checks-effects-interactions).
    /// @param from        Payer of the funds and the signer of the authorization
    /// @param to          Recipient of the funds
    /// @param value       Amount to transfer (in base units, 6 decimals)
    /// @param validAfter  Unix timestamp after which the authorization is valid
    /// @param validBefore Unix timestamp before which the authorization is valid
    /// @param nonce       Unique 32-byte nonce chosen by the signer
    /// @param v           ECDSA v parameter
    /// @param r           ECDSA r parameter
    /// @param s           ECDSA s parameter
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, v, r, s);
        if (signer != from) revert InvalidSignature();

        // Effects
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        // Interactions (internal transfer only — no external calls)
        _transfer(from, to, value);
    }

    /// @notice Owner-only mint used to seed initial supply for the hackathon demo.
    /// @param to     Recipient of newly minted tokens
    /// @param amount Amount to mint in base units (10^6 = 1 USDT)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
