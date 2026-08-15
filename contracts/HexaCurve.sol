// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {HexaToken} from "./HexaToken.sol";
import {FeeVault} from "./FeeVault.sol";

interface IHexaConfig {
    function migrator() external view returns (address);
}

/// @notice One bonding curve per launch. Deployed as an EIP-1167 clone by HexaFactory.
///
/// ARC-SPECIFIC DESIGN (see docs/ARC-CONSTRAINTS.md):
///
///  * Money comes IN as `msg.value` (native, 18 decimals) — so buying needs no approve.
///    Money goes OUT as a USDC ERC-20 `transfer` (6 decimals). On Arc these are the same
///    pool of funds viewed two ways, so this is not a conversion. The direction matters:
///    a native `call{value:}` to a contract can revert for reasons outside our control,
///    while a plain ERC-20 transfer invokes no callback.
///
///  * Every rounding goes to the pool, never the user. Reserve updates use ceiling
///    division so the output side is always the one that loses the remainder.
///
///  * Windows are counted in `block.number`. Arc's sub-second blocks share timestamps and
///    `block.timestamp` is only non-decreasing, so a timestamp window is unenforceable.
contract HexaCurve {
    // ─────────────────────────────── constants ───────────────────────────────

    uint256 private constant BPS = 10_000;
    uint256 public constant FEE_BPS = 100; // 1% total trading fee

    // Fee split, in bps of the fee. See docs/FEES.md.
    uint256 private constant REF_SHARE = 2_000; // 20% to referrer, when there is one
    uint256 private constant CREATOR_SHARE_REFERRED = 4_000;
    uint256 private constant CREATOR_SHARE_PLAIN = 5_000;

    /// @dev Native (18-dec) to USDC ERC-20 (6-dec). Same funds, 12 orders of magnitude apart.
    uint256 private constant NATIVE_TO_ERC20 = 1e12;

    // ─────────────────────────────── storage ───────────────────────────────

    IERC20 public usdc;
    FeeVault public vault;
    HexaToken public token;
    address public creator;
    address public treasury;
    address public factory;

    // Two slots.
    uint128 public virtualUsdc;
    uint128 public virtualTokens;
    uint128 public realUsdc;
    uint128 public realTokens;

    uint64 public revealBlock;
    uint64 public guardBlocks;
    uint64 public taxBlocks;
    uint16 public maxBuyBps;
    uint16 public sellTaxStartBps;
    uint16 public sellTaxFloorBps;
    uint16 public creatorMaxBps;
    /**
     * Smallest accepted buy, in 18-decimal native units. uint64 caps it near 18 USDC, which
     * is far above anything sensible for a floor and keeps this struct inside one slot.
     *
     * Dust buys are not free to anyone: each one is a row in the trade index, a wallet in the
     * "new wallets" count that Trending reads, and a referral binding. A floor makes spamming
     * those signals cost money instead of gas.
     */
    uint64 public minBuyIn;
    bool public graduated;
    bool public released;
    uint8 private _locked;

    /// @notice First-touch, permanent, per-token referral attribution. Single tier.
    mapping(address => address) public referrerOf;
    /// @notice Tokens bought per wallet while the guard window is open.
    mapping(address => uint256) public boughtInGuard;
    uint256 public creatorHeld;

    // ─────────────────────────────── events ───────────────────────────────

    event Bought(address indexed buyer, address indexed to, uint256 nativeIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 nativeOut, uint256 fee, uint256 tax);
    event ReferrerBound(address indexed trader, address indexed referrer);
    event Graduated(uint256 realUsdc, uint256 lpTokens);
    event Released(uint256 usdc6, uint256 tokenAmount);

    // ─────────────────────────────── errors ───────────────────────────────

    error AlreadyInitialized();
    error Graduated_();
    error Slippage();
    error Reentrancy();
    error GuardCapExceeded(uint256 cap, uint256 attempted);
    error CreatorCapExceeded(uint256 cap);
    error ZeroAmount();
    error BelowMinBuy(uint64 minimum);
    error NotMigrator();
    error NotGraduated();
    error AlreadyReleased();

    struct InitParams {
        IERC20 usdc;
        FeeVault vault;
        HexaToken token;
        address creator;
        address treasury;
        uint128 virtualUsdc;
        uint128 virtualTokens;
        uint128 realTokens;
        uint64 guardBlocks;
        uint64 taxBlocks;
        uint16 maxBuyBps;
        uint16 sellTaxStartBps;
        uint16 sellTaxFloorBps;
        uint16 creatorMaxBps;
        uint64 minBuyIn;
    }

    modifier lock() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier live() {
        if (graduated) revert Graduated_();
        _;
    }

    function initialize(InitParams calldata p) external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
        usdc = p.usdc;
        vault = p.vault;
        token = p.token;
        creator = p.creator;
        treasury = p.treasury;
        virtualUsdc = p.virtualUsdc;
        virtualTokens = p.virtualTokens;
        realTokens = p.realTokens;
        revealBlock = uint64(block.number);
        guardBlocks = p.guardBlocks;
        taxBlocks = p.taxBlocks;
        maxBuyBps = p.maxBuyBps;
        sellTaxStartBps = p.sellTaxStartBps;
        sellTaxFloorBps = p.sellTaxFloorBps;
        creatorMaxBps = p.creatorMaxBps;
        minBuyIn = p.minBuyIn;
    }

    // ─────────────────────────────── trading ───────────────────────────────

    /// @param referrer Proposed referrer. Ignored if this trader already has one, if it is
    ///                 zero, or if it is the trader themselves. See docs/FEES.md on why
    ///                 self-referral via a second wallet is accepted rather than fought.
    function buy(uint256 minTokensOut, address to, address referrer)
        external
        payable
        lock
        live
        returns (uint256 tokensOut)
    {
        if (msg.value < minBuyIn) revert BelowMinBuy(minBuyIn);

        uint256 fee = (msg.value * FEE_BPS) / BPS;
        uint256 netIn = msg.value - fee;

        uint256 vU = virtualUsdc;
        uint256 vT = virtualTokens;
        uint256 newVU = vU + netIn;
        // Ceiling here means the reserve stays high and tokensOut rounds down — to the pool.
        uint256 newVT = _ceilDiv(vU * vT, newVU);
        tokensOut = vT - newVT;

        // The buy that finishes the curve is capped at whatever is left, rather than
        // reverting. Reverting looked safer, but with the output rounded down in the pool's
        // favour there is no input that lands realTokens on exactly zero — so graduation
        // would have been unreachable, and the most important buy of a launch would fail.
        //
        // Overpaying on that last buy is caught by minTokensOut, which every caller sets:
        // ask for more tokens than the remainder can supply and the slippage check rejects
        // it. The surplus USDC stays in the curve and ends up in the pool.
        if (tokensOut > realTokens) {
            tokensOut = realTokens;
            newVT = vT - tokensOut;
        }
        if (tokensOut < minTokensOut) revert Slippage();
        _checkGuard(to, tokensOut);
        _checkCreatorCap(to, tokensOut);

        virtualUsdc = uint128(newVU);
        virtualTokens = uint128(newVT);
        realUsdc += uint128(netIn);
        realTokens -= uint128(tokensOut);

        _settleFee(fee, to, referrer);
        token.transfer(to, tokensOut);
        emit Bought(msg.sender, to, msg.value, tokensOut, fee);

        if (realTokens == 0) _graduate();
    }

    function sell(uint256 amountIn, uint256 minNativeOut, address to)
        external
        lock
        live
        returns (uint256 nativeOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        token.transferFrom(msg.sender, address(this), amountIn);

        uint256 vU = virtualUsdc;
        uint256 vT = virtualTokens;
        uint256 newVT = vT + amountIn;
        // Ceiling again: the USDC reserve stays high, so gross output rounds down.
        uint256 newVU = _ceilDiv(vU * vT, newVT);
        uint256 gross = vU - newVU;

        uint256 tax = (gross * sellTaxBps()) / BPS;
        uint256 fee = (gross * FEE_BPS) / BPS;
        nativeOut = gross - tax - fee;
        if (nativeOut < minNativeOut) revert Slippage();

        virtualUsdc = uint128(newVU);
        virtualTokens = uint128(newVT);
        realTokens += uint128(amountIn);
        // The tax is deliberately NOT removed from realUsdc. It stays in the curve and ends
        // up in the liquidity pool at graduation, so a snipe subsidises everyone still in.
        realUsdc -= uint128(gross - tax);

        _settleFee(fee, msg.sender, address(0));

        // 6-decimal leg. The sub-1e-6 remainder is left behind, which favours the pool.
        usdc.transfer(to, nativeOut / NATIVE_TO_ERC20);
        emit Sold(msg.sender, to, amountIn, nativeOut, fee, tax);
    }

    // ─────────────────────────────── anti-snipe ───────────────────────────────

    /// @notice Caps what the creator can buy of their own launch, and publishes the running
    ///         total so the UI can always show "creator holds N%".
    ///
    /// This lives inside buy() rather than in a separate creatorBuy() entry point, because a
    /// cap the creator can skip by calling the ordinary function is not a cap.
    ///
    /// It bounds the disclosed creator address only. A creator buying from an unrelated
    /// wallet is still possible and still invisible — nothing on-chain can distinguish two
    /// wallets. The per-wallet guard cap is what limits the damage in that case. Pump.fun's
    /// real failure was never that founders bought their own launch; it was that they did it
    /// from an unlabelled second wallet while the UI showed nothing at all.
    function _checkCreatorCap(address to, uint256 tokensOut) private {
        if (to != creator) return;
        uint256 held = creatorHeld + tokensOut;
        uint256 cap = (token.totalSupply() * creatorMaxBps) / BPS;
        if (held > cap) revert CreatorCapExceeded(cap);
        creatorHeld = held;
    }

    /// @notice Sell tax in bps, decaying linearly from `sellTaxStartBps` to `sellTaxFloorBps`
    ///         over `taxBlocks` blocks. Monotonically non-increasing.
    ///
    /// Buying early is never blocked — blocking early buyers just moves the game to who gets
    /// allowlisted. Instead the opening window is a terrible time to flip and a fine time to
    /// hold, which is the incentive a fair launch actually wants.
    function sellTaxBps() public view returns (uint256) {
        uint256 elapsed = block.number - revealBlock;
        if (elapsed >= taxBlocks) return sellTaxFloorBps;
        uint256 span = uint256(sellTaxStartBps) - uint256(sellTaxFloorBps);
        return uint256(sellTaxStartBps) - (span * elapsed) / taxBlocks;
    }

    function inGuardWindow() public view returns (bool) {
        return block.number < revealBlock + guardBlocks;
    }

    /// @dev A per-wallet cap bounds one actor's blast radius; it does not stop them, because
    ///      wallets are free and Arc offers no sybil resistance. The decaying tax is the part
    ///      that actually works, since splitting wallets does not reduce it.
    function _checkGuard(address to, uint256 tokensOut) private {
        if (!inGuardWindow()) return;
        // The creator is governed by creatorMaxBps instead — a stricter, permanent, publicly
        // displayed cap. The guard cap exists to stop anonymous accumulation in the opening
        // window; a disclosed creator allocation taken atomically at launch is the honest
        // version of what they would otherwise do quietly across several wallets anyway.
        if (to == creator) return;
        uint256 cap = (token.totalSupply() * maxBuyBps) / BPS;
        uint256 total = boughtInGuard[to] + tokensOut;
        if (total > cap) revert GuardCapExceeded(cap, total);
        boughtInGuard[to] = total;
    }

    // ─────────────────────────────── fees ───────────────────────────────

    function _settleFee(uint256 fee18, address trader, address proposedRef) private {
        uint256 fee6 = fee18 / NATIVE_TO_ERC20;
        if (fee6 == 0) return; // dust trade; the fee stays in the curve

        address ref = _bindReferrer(trader, proposedRef);

        uint256 toRef = ref == address(0) ? 0 : (fee6 * REF_SHARE) / BPS;
        uint256 toCreator =
            ((fee6 * (ref == address(0) ? CREATOR_SHARE_PLAIN : CREATOR_SHARE_REFERRED)) / BPS);
        // Protocol takes the remainder, so the three parts always sum to exactly fee6 and
        // the vault can never owe more than it was funded.
        uint256 toProtocol = fee6 - toRef - toCreator;

        usdc.transfer(address(vault), fee6);
        vault.credit([treasury, creator, ref], [toProtocol, toCreator, toRef]);
    }

    /// @dev First-touch and permanent: a later referrer cannot steal attribution from the
    ///      person who actually did the work, and it costs one write per trader, not per trade.
    function _bindReferrer(address trader, address proposed) private returns (address) {
        address existing = referrerOf[trader];
        if (existing != address(0)) return existing;
        if (proposed == address(0) || proposed == trader) return address(0);
        referrerOf[trader] = proposed;
        emit ReferrerBound(trader, proposed);
        return proposed;
    }

    // ─────────────────────────────── graduation ───────────────────────────────

    function _graduate() private {
        graduated = true;
        emit Graduated(realUsdc, token.balanceOf(address(this)));
    }

    /// @notice Hands the raised USDC and the held-back token supply to the migrator, which
    ///         creates the pool and locks the position in the same transaction.
    ///
    /// The migrator is read from the factory rather than stored at initialize, so the
    /// liquidity venue can be configured after the curve template is deployed — on Arc that
    /// matters, because testnet needs a self-deployed Uniswap v3 fixture while mainnet uses
    /// the canonical one. See docs/CURVE.md §5.
    function releaseForMigration() external lock returns (uint256 usdc6, uint256 tokenAmount) {
        if (msg.sender != IHexaConfig(factory).migrator()) revert NotMigrator();
        if (!graduated) revert NotGraduated();
        if (released) revert AlreadyReleased();
        released = true;

        // Floor to whole 6-decimal units. The sub-1e-6 remainder is stranded here forever:
        // it cannot be burned on Arc and is worth less than a millionth of a dollar.
        usdc6 = uint256(realUsdc) / NATIVE_TO_ERC20;
        tokenAmount = token.balanceOf(address(this));

        usdc.transfer(msg.sender, usdc6);
        token.transfer(msg.sender, tokenAmount);
        emit Released(usdc6, tokenAmount);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Largest native input that still buys strictly less than the whole remainder,
    ///         fee included. Frontends size the final buy with this so the user does not
    ///         overpay into the cap in buy(). Rounded down for that reason — rounding up
    ///         returns a number that buys past the remainder and wastes the difference.
    function maxBuyIn() public view returns (uint256) {
        uint256 vT = virtualTokens;
        uint256 rT = realTokens;
        if (rT == 0) return 0;
        uint256 newVT = vT - rT;
        uint256 newVU = _ceilDiv(uint256(virtualUsdc) * vT, newVT);
        uint256 netIn = newVU - virtualUsdc;
        return (netIn * BPS) / (BPS - FEE_BPS);
    }

    function quoteBuy(uint256 nativeIn) external view returns (uint256 tokensOut) {
        uint256 netIn = nativeIn - (nativeIn * FEE_BPS) / BPS;
        uint256 vU = virtualUsdc;
        uint256 vT = virtualTokens;
        tokensOut = vT - _ceilDiv(vU * vT, vU + netIn);
        if (tokensOut > realTokens) tokensOut = realTokens;
    }

    function quoteSell(uint256 amountIn) external view returns (uint256 nativeOut) {
        uint256 vU = virtualUsdc;
        uint256 vT = virtualTokens;
        uint256 gross = vU - _ceilDiv(vU * vT, vT + amountIn);
        nativeOut = gross - (gross * sellTaxBps()) / BPS - (gross * FEE_BPS) / BPS;
    }

    /// @notice Native USDC per whole token, scaled by 1e18.
    function priceX18() external view returns (uint256) {
        return (uint256(virtualUsdc) * 1e18) / virtualTokens;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
