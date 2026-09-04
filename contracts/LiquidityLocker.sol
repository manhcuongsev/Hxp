// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {FeeVault} from "./FeeVault.sol";

interface IHexaTreasury {
    function treasury() external view returns (address);
}

/// @notice Owns every graduated liquidity position, forever.
///
/// THIS CONTRACT IS THE PRODUCT PROMISE. Read what is missing from it:
///
///   * no withdraw          * no unlock          * no emergency exit
///   * no owner             * no admin           * no upgrade path
///   * no timelock          * no governance vote * no migration hatch
///
/// "Liquidity is locked" is only worth saying if no code path could ever unlock it. Not a
/// path guarded by a multisig, not one behind a delay — none at all. The only external
/// function that touches the pool is collectFees(), and it calls burn() with a hardcoded
/// zero, which in Uniswap v3 updates fee accounting without removing any liquidity.
///
/// There is deliberately no variable to hold a burn amount anywhere in this file.
///
/// On Arc this is also the only workable design for the USDC side: native value cannot be
/// sent to the zero address, so "burning" the liquidity is not an option even if it were
/// desirable. See docs/ARC-CONSTRAINTS.md §4.
contract LiquidityLocker {
    /// @dev Full range for the 1% fee tier (tickSpacing 200), aligned to the spacing.
    int24 public constant TICK_LOWER = -887_200;
    int24 public constant TICK_UPPER = 887_200;

    address public immutable migrator;
    FeeVault public immutable vault;
    IERC20 public immutable usdc;

    struct Position {
        address pool;
        address token;
        address creator;
        bool exists;
    }

    mapping(address pool => Position) public positions;
    address[] public allPools;

    event Locked(address indexed pool, address indexed token, address indexed creator, uint128 liquidity);
    event FeesCollected(address indexed pool, uint256 amount0, uint256 amount1);

    error NotMigrator();
    error UnknownPool();
    error AlreadyLocked();

    constructor(address _migrator, FeeVault _vault, IERC20 _usdc) {
        migrator = _migrator;
        vault = _vault;
        usdc = _usdc;
    }

    /// @notice Recorded by the migrator immediately after it mints the position to this
    ///         contract. The position itself already lives in the pool, keyed to this
    ///         address — this only records what exists so fees can be found later.
    function record(address pool, address token, address creator, uint128 liquidity) external {
        if (msg.sender != migrator) revert NotMigrator();
        if (positions[pool].exists) revert AlreadyLocked();
        positions[pool] = Position(pool, token, creator, true);
        allPools.push(pool);
        emit Locked(pool, token, creator, liquidity);
    }

    /// @notice Sweep accrued trading fees. Permissionless — anyone may pay the gas, and the
    ///         proceeds go where they were always going to go.
    ///
    /// The USDC leg is split per FeeConfig and credited to FeeVault for the protocol and the
    /// creator to pull. The token leg is left in this contract: selling a creator's own coin
    /// on their behalf is not a decision a locker should be making.
    function collectFees(address pool) external returns (uint256 amount0, uint256 amount1) {
        Position memory p = positions[pool];
        if (!p.exists) revert UnknownPool();

        // Zero-amount burn: pokes the position so tokensOwed reflects accrued fees.
        // This does not remove liquidity, and no other amount is reachable from this file.
        IUniswapV3Pool(pool).burn(TICK_LOWER, TICK_UPPER, 0);

        (uint128 c0, uint128 c1) = IUniswapV3Pool(pool).collect(
            address(this), TICK_LOWER, TICK_UPPER, type(uint128).max, type(uint128).max
        );
        (amount0, amount1) = (c0, c1);

        address t0 = IUniswapV3Pool(pool).token0();
        uint256 usdcAmount = t0 == address(usdc) ? amount0 : amount1;

        if (usdcAmount > 0) {
            // 70/30 creator/protocol. Referral attribution cannot survive graduation: pool
            // fees accrue in aggregate with no per-trade record to attribute. docs/FEES.md.
            //
            // Protocol takes the remainder rather than its own percentage, so the two parts
            // always sum to exactly usdcAmount and the vault can never owe more than it holds.
            uint256 toCreator = (usdcAmount * 7_000) / 10_000;
            uint256 toProtocol = usdcAmount - toCreator;
            usdc.transfer(address(vault), usdcAmount);
            vault.credit(
                [IHexaTreasury(vault.factory()).treasury(), p.creator, address(0)],
                [toProtocol, toCreator, uint256(0)]
            );
        }

        emit FeesCollected(pool, amount0, amount1);
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }
}
