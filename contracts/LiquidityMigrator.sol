// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback} from "./interfaces/IUniswapV3.sol";
import {HexaCurve} from "./HexaCurve.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";

interface IHexaRegistry {
    function commitOfToken(address token) external view returns (bytes32);
    function launches(bytes32 h)
        external
        view
        returns (address curve, address token, address creator, uint64 cb, uint64 rb, uint8 phase);
}

/// @notice Moves a graduated curve's liquidity into a Uniswap v3 pool and locks it, in one
///         atomic call. Permissionless: if this needed a privileged keeper, a keeper outage
///         would freeze every graduated coin.
///
/// The v3 factory address is a constructor argument, never a constant, because it differs by
/// environment — Arc testnet has no Uniswap at all and needs a self-deployed v3 fixture,
/// while Arc mainnet has Uniswap's canonical deployment from day one and a parallel pool
/// there would split liquidity against it. See docs/CURVE.md §5.
contract LiquidityMigrator is IUniswapV3MintCallback {
    /// @dev 1% tier. Post-graduation fees are charged by the pool itself, which is the only
    ///      unbypassable way to charge on a permissionless AMM — a router fee is skipped by
    ///      calling the pool directly. We own 100% of the (locked) liquidity, so we earn all
    ///      of it. docs/CURVE.md §5.
    uint24 public constant FEE_TIER = 10_000;
    int24 public constant TICK_LOWER = -887_200;
    int24 public constant TICK_UPPER = 887_200;

    IUniswapV3Factory public immutable v3Factory;
    IHexaRegistry public immutable hexaFactory;
    LiquidityLocker public locker;
    IERC20 public immutable usdc;
    address public immutable deployer;

    /// @dev Set only for the duration of a mint, so the callback can prove its caller.
    address private _mintingPool;

    event Migrated(
        address indexed token, address indexed pool, uint256 usdcIn, uint256 tokensIn, uint128 liquidity
    );

    error NotHexaToken();
    error AlreadyMigrated();
    error NothingToMigrate();
    error BadCallback();
    error LockerAlreadySet();
    error NotDeployer();

    constructor(IUniswapV3Factory _v3Factory, IHexaRegistry _hexaFactory, IERC20 _usdc) {
        v3Factory = _v3Factory;
        hexaFactory = _hexaFactory;
        usdc = _usdc;
        deployer = msg.sender;
    }

    /// @dev Migrator and locker reference each other, so one of them has to be wired after
    ///      construction. Write-once, and only by whoever deployed this.
    function setLocker(LiquidityLocker _locker) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(locker) != address(0)) revert LockerAlreadySet();
        locker = _locker;
    }

    function migrate(address token) external returns (address pool) {
        bytes32 commitHash = hexaFactory.commitOfToken(token);
        if (commitHash == bytes32(0)) revert NotHexaToken();
        (address curveAddr,, address creator,,,) = hexaFactory.launches(commitHash);

        HexaCurve curve = HexaCurve(curveAddr);
        (uint256 usdcIn, uint256 tokensIn) = curve.releaseForMigration();
        if (usdcIn == 0 || tokensIn == 0) revert NothingToMigrate();

        pool = v3Factory.getPool(token, address(usdc), FEE_TIER);
        if (pool == address(0)) pool = v3Factory.createPool(token, address(usdc), FEE_TIER);

        bool tokenIsToken0 = token < address(usdc);
        (uint256 amount0, uint256 amount1) =
            tokenIsToken0 ? (tokensIn, usdcIn) : (usdcIn, tokensIn);

        IUniswapV3Pool(pool).initialize(_sqrtPriceX96(amount0, amount1));

        // At full range the position's liquidity is the constant-product value sqrt(x*y).
        // Shaved by 0.1% because the range is the widest aligned tick pair rather than the
        // true limits, so the exact requirement is a hair under. Undershooting leaves dust;
        // overshooting makes the mint callback ask for more than we hold and reverts.
        uint128 liquidity = uint128((_sqrt(amount0 * amount1) * 999) / 1000);

        _mintingPool = pool;
        IUniswapV3Pool(pool).mint(address(locker), TICK_LOWER, TICK_UPPER, liquidity, "");
        _mintingPool = address(0);

        locker.record(pool, token, creator, liquidity);

        // Rounding dust stays here. It is not swept anywhere: on Arc it cannot be burned,
        // and giving it a destination would mean giving this contract a transfer path.
        emit Migrated(token, pool, usdcIn, tokensIn, liquidity);
    }

    /// @dev Uniswap calls this to collect payment. Without the caller check, anyone could
    ///      invoke it directly and drain whatever this contract holds mid-migration.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata)
        external
        override
    {
        if (msg.sender != _mintingPool) revert BadCallback();
        address t0 = IUniswapV3Pool(msg.sender).token0();
        address t1 = IUniswapV3Pool(msg.sender).token1();
        if (amount0Owed > 0) IERC20(t0).transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(t1).transfer(msg.sender, amount1Owed);
    }

    // ─────────────────────────────── math ───────────────────────────────

    /// @notice sqrt(amount1/amount0) * 2^96, in Uniswap's Q64.96 form.
    /// @dev Split as sqrt(x << 96) << 48 to keep the intermediate inside uint256: shifting
    ///      by the full 192 first would overflow for realistic token amounts.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratioX96 = (amount1 << 96) / amount0;
        return uint160(_sqrt(ratioX96) << 48);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        // Babylonian, seeded near 2^(log2(x)/2) so it converges in a handful of rounds.
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }
}
