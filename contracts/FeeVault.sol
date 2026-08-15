// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";

/// @notice Accrues fees and pays them out on demand. Nothing is ever pushed.
///
/// On Arc, forwarding native value to a contract can revert for reasons the sender does not
/// control, and transfers to or from a blocklisted address revert at runtime. A push-based
/// split would therefore let one hostile or blocklisted recipient brick every trade on a
/// token. With pull, the only thing such a recipient can break is their own claim().
///
/// All accounting here is in 6-decimal USDC ERC-20 units — the same units the vault actually
/// holds — so `owed` can never promise more than the vault can pay.
contract FeeVault {
    IERC20 public immutable usdc;
    address public immutable factory;

    /// @dev Only contracts registered by the factory may credit — the curves, plus the
    ///      liquidity locker once graduated pools start earning. Otherwise anyone could
    ///      inflate `owed` without funding it and drain the vault.
    mapping(address => bool) public isCreditor;
    mapping(address => uint256) public owed;

    uint256 public totalOwed;

    event Credited(address indexed to, uint256 amount, address indexed curve);
    event Claimed(address indexed to, uint256 amount);
    event CreditorRegistered(address indexed creditor);

    error NotFactory();
    error NotCreditor();
    error NothingOwed();
    error Underfunded();

    constructor(IERC20 _usdc, address _factory) {
        usdc = _usdc;
        factory = _factory;
    }

    function registerCreditor(address creditor) external {
        if (msg.sender != factory) revert NotFactory();
        isCreditor[creditor] = true;
        emit CreditorRegistered(creditor);
    }

    /// @notice Record what each party is owed. The curve must have already transferred the
    ///         matching USDC to this contract in the same transaction.
    /// @dev Amounts are 6-decimal. The caller splits an amount it has actually moved, so
    ///      `totalOwed` stays backed one-for-one.
    function credit(address[3] calldata to, uint256[3] calldata amount) external {
        if (!isCreditor[msg.sender]) revert NotCreditor();

        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            if (to[i] == address(0) || amount[i] == 0) continue;
            owed[to[i]] += amount[i];
            sum += amount[i];
            emit Credited(to[i], amount[i], msg.sender);
        }
        totalOwed += sum;

        // The vault must hold at least everything it has promised. Checking here means a
        // miscounted split fails at the trade rather than silently at some later claim.
        if (usdc.balanceOf(address(this)) < totalOwed) revert Underfunded();
    }

    function claim() external returns (uint256 amount) {
        amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        emit Claimed(msg.sender, amount);
        usdc.transfer(msg.sender, amount);
    }
}
