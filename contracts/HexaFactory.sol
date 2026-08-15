// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {HexaToken} from "./HexaToken.sol";
import {HexaCurve} from "./HexaCurve.sol";
import {FeeVault} from "./FeeVault.sol";

/// @notice The single entry point for every Hexapus launch.
///
/// Because every token is created here, an indexer subscribes to exactly one address and
/// never has to discover contracts by scanning the chain.
///
/// Launching is COMMIT-REVEAL. Arc has a public mempool with first-come-first-served
/// ordering and no MEV protection, so a bot can see and race the reveal transaction. What it
/// cannot do is decide, in the milliseconds available, whether an unknown token is worth
/// buying — until reveal lands, the name, the image and even the address are unknown.
/// Commit-reveal does not stop a bot from being fast. It stops speed from being worth
/// anything. And because Arc orders FCFS rather than by gas price, a bot cannot buy its way
/// to the front either.
contract HexaFactory {
    enum Phase {
        NONE,
        COMMITTED,
        CURVE_LIVE,
        GRADUATED
    }

    struct Launch {
        address curve;
        address token;
        address creator;
        uint64 commitBlock;
        uint64 revealBlock;
        Phase phase;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        uint256 totalSupply;
        uint128 virtualUsdc;
        uint128 virtualTokens;
        uint128 realTokens;
    }

    /// @notice Anti-snipe and curve defaults. Config, not constants — every one of these has
    ///         to be calibrated against Arc's real block rate under load, and raising them
    ///         later must be a config change rather than a redeploy of the curve template.
    struct Defaults {
        uint64 guardBlocks;
        uint64 taxBlocks;
        uint16 maxBuyBps;
        uint16 sellTaxStartBps;
        uint16 sellTaxFloorBps;
        uint16 creatorMaxBps;
        uint64 minBuyIn;
    }

    IERC20 public immutable usdc;
    FeeVault public immutable vault;
    address public immutable curveTemplate;

    address public owner;
    address public treasury;
    /**
     * Charged on reveal, in 18-decimal native units. Deliberately not charged on commit: a
     * commit that is never revealed costs its sender gas and nothing else, and charging for
     * one would put a price on an action that produces no coin.
     */
    uint128 public creationFee;
    /// @dev Read by every curve at graduation. Configurable because the liquidity venue
    ///      differs by environment: Arc testnet needs a self-deployed Uniswap v3 fixture,
    ///      mainnet uses the canonical deployment. docs/CURVE.md §5.
    address public migrator;
    Defaults public defaults;

    /// @dev Long enough that a bot seeing the reveal cannot retroactively have been in the
    ///      commit; short enough not to be annoying. Arc blocks are sub-second.
    uint64 public constant COMMIT_MIN_BLOCKS = 12;
    /// @dev So an abandoned commit cannot squat a hash forever.
    uint64 public constant COMMIT_TTL_BLOCKS = 7_200;

    mapping(bytes32 => Launch) public launches;
    mapping(address => bytes32) public commitOfToken;

    event Committed(bytes32 indexed commitHash, address indexed creator, uint64 blockNo);
    event Launched(
        bytes32 indexed commitHash,
        address indexed token,
        address indexed curve,
        address creator,
        string name,
        string symbol,
        string metadataURI
    );
    event DefaultsChanged(Defaults defaults);
    event TreasuryChanged(address treasury);
    event LiquidityChanged(address migrator, address locker);
    event CreationFeeChanged(uint128 fee);

    error NotOwner();
    error AlreadyCommitted();
    error NoSuchCommit();
    error WrongPhase();
    error TooEarly(uint64 readyAtBlock);
    error CommitExpired();
    error HashMismatch();
    error BadParams();
    error CloneFailed();
    error CreationFeeUnpaid(uint128 required);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 _usdc, address _treasury, Defaults memory _defaults, uint128 _creationFee) {
        owner = msg.sender;
        usdc = _usdc;
        treasury = _treasury;
        defaults = _defaults;
        creationFee = _creationFee;
        vault = new FeeVault(_usdc, address(this));
        // The factory credits creation fees itself, so it has to be a creditor like the curves.
        vault.registerCreditor(address(this));
        curveTemplate = address(new HexaCurve());
    }

    // ─────────────────────────────── launch ───────────────────────────────

    /// @notice Step 1. Publishes nothing about the token — not the name, symbol, image,
    ///         supply, curve parameters, or resulting address.
    /// @param commitHash keccak256(abi.encode(creator, params, salt))
    function commit(bytes32 commitHash) external {
        Launch storage l = launches[commitHash];
        if (l.phase != Phase.NONE) revert AlreadyCommitted();
        l.creator = msg.sender;
        l.commitBlock = uint64(block.number);
        l.phase = Phase.COMMITTED;
        emit Committed(commitHash, msg.sender, uint64(block.number));
    }

    /// @notice Step 2. Deploys the token and curve and opens trading, all in one transaction.
    ///
    /// @dev Send value to buy in atomically with the launch. This does NOT make the launch
    ///      snipe-proof — once this transaction is in Arc's public mempool the name, the
    ///      parameters and the deterministic address are all readable, and FCFS ordering
    ///      makes the rest a latency race. What it does is make the creator's allocation
    ///      land in the same instant as the launch, at a published size, from the disclosed
    ///      creator address. That is a transparency property, not a security one, and no
    ///      amount of transaction batching changes the security side.
    function reveal(LaunchParams calldata p, bytes32 salt)
        external
        payable
        returns (address token, address curve)
    {
        bytes32 commitHash = hashLaunch(msg.sender, p, salt);
        Launch storage l = launches[commitHash];

        if (l.phase == Phase.NONE) revert NoSuchCommit();
        if (l.phase != Phase.COMMITTED) revert WrongPhase();
        if (l.creator != msg.sender) revert HashMismatch();

        uint64 readyAt = l.commitBlock + COMMIT_MIN_BLOCKS;
        if (block.number < readyAt) revert TooEarly(readyAt);
        if (block.number > l.commitBlock + COMMIT_TTL_BLOCKS) revert CommitExpired();

        if (msg.value < creationFee) revert CreationFeeUnpaid(creationFee);

        if (
            p.totalSupply == 0 || p.realTokens == 0 || p.virtualUsdc == 0
                || p.virtualTokens <= p.realTokens || p.realTokens > p.totalSupply
        ) revert BadParams();

        // Salt derives from the commit hash, which derives from a secret. The curve address
        // is therefore not computable by anyone before the reveal transaction lands.
        curve = _clone(curveTemplate, commitHash);

        // Whole supply to the curve at construction: `realTokens` is sellable on the curve,
        // the remainder is the liquidity side held back for the pool.
        token = address(new HexaToken{salt: commitHash}(p.name, p.symbol, p.totalSupply, curve));

        vault.registerCreditor(curve);
        HexaCurve(curve).initialize(
            HexaCurve.InitParams({
                usdc: usdc,
                vault: vault,
                token: HexaToken(token),
                creator: msg.sender,
                treasury: treasury,
                virtualUsdc: p.virtualUsdc,
                virtualTokens: p.virtualTokens,
                realTokens: p.realTokens,
                guardBlocks: defaults.guardBlocks,
                taxBlocks: defaults.taxBlocks,
                maxBuyBps: defaults.maxBuyBps,
                sellTaxStartBps: defaults.sellTaxStartBps,
                sellTaxFloorBps: defaults.sellTaxFloorBps,
                creatorMaxBps: defaults.creatorMaxBps,
                minBuyIn: defaults.minBuyIn
            })
        );

        l.curve = curve;
        l.token = token;
        l.revealBlock = uint64(block.number);
        l.phase = Phase.CURVE_LIVE;
        commitOfToken[token] = commitHash;

        emit Launched(commitHash, token, curve, msg.sender, p.name, p.symbol, p.metadataURI);

        // Whatever is sent beyond the creation fee becomes the creator's buy-in, so a launch
        // with no buy-in sends exactly the fee and one with a buy-in sends fee + amount.
        uint256 buyIn = msg.value - creationFee;
        _takeCreationFee();

        // Bounded by creatorMaxBps inside the curve, and recorded in the public creatorHeld.
        if (buyIn > 0) HexaCurve(curve).buy{value: buyIn}(0, msg.sender, address(0));
    }

    /**
     * Moves the creation fee into the vault as an ERC-20 transfer and credits the treasury.
     *
     * It arrives as `msg.value` (18-dec native) and leaves as USDC (6-dec) — the same funds
     * under Arc's two views. Credited rather than sent, so the treasury pulls it like every
     * other fee in the system and a blocked treasury cannot break launching for everyone.
     */
    function _takeCreationFee() private {
        uint256 fee6 = uint256(creationFee) / 1e12;
        if (fee6 == 0) return;
        usdc.transfer(address(vault), fee6);
        vault.credit([treasury, address(0), address(0)], [fee6, uint256(0), uint256(0)]);
    }

    function hashLaunch(address creator, LaunchParams calldata p, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(creator, p, salt));
    }

    // ─────────────────────────────── admin ───────────────────────────────

    function setDefaults(Defaults calldata d) external onlyOwner {
        defaults = d;
        emit DefaultsChanged(d);
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
        emit TreasuryChanged(t);
    }

    function setCreationFee(uint128 fee) external onlyOwner {
        creationFee = fee;
        emit CreationFeeChanged(fee);
    }

    /// @notice Point curves at the migrator, and let the locker credit graduated-pool fees.
    function setLiquidity(address _migrator, address _locker) external onlyOwner {
        migrator = _migrator;
        vault.registerCreditor(_locker);
        emit LiquidityChanged(_migrator, _locker);
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
    }

    // ─────────────────────────────── internals ───────────────────────────────

    /// @dev EIP-1167 minimal proxy via CREATE2. A full curve deployment per launch would be
    ///      many times the gas for identical bytecode.
    function _clone(address impl, bytes32 salt) private returns (address inst) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            inst := create2(0, ptr, 0x37, salt)
        }
        if (inst == address(0)) revert CloneFailed();
    }
}
