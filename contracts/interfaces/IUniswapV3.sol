// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Only the parts of Uniswap v3 that Hexapus touches.
///
/// Deliberately narrow: Hexapus never manages a position after creating it, so it needs
/// neither NonfungiblePositionManager nor anything else from v3-periphery. Avoiding
/// periphery also avoids its WETH9 dependency, which is meaningless on Arc — the pool is
/// (HexaToken, USDC ERC-20) and there is nothing to wrap.
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;

    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    /// @dev Calling with amount = 0 does NOT remove liquidity. It re-computes the position's
    ///      owed fees so collect() can take them. This is the only form Hexapus ever uses.
    function burn(int24 tickLower, int24 tickUpper, uint128 amount)
        external
        returns (uint256 amount0, uint256 amount1);

    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

interface IUniswapV3MintCallback {
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data)
        external;
}
