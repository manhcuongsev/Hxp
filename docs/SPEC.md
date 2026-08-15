# Hexapus — contract specification v0.1

Target: **Arc** (chain `5042002` testnet). Read [ARC-CONSTRAINTS.md](ARC-CONSTRAINTS.md) first —
every design decision below traces to a constraint there, and several of them are not
negotiable on this chain.

Status: design. No Solidity written yet. Nothing here is audited.

---

## 0. The five decisions that shape everything

| # | Decision | Forced by |
|---|---|---|
| 1 | **Hexapus ships its own AMM.** There is no Uniswap on Arc to graduate onto. | ARC §2 |
| 2 | **Money in via `msg.value`, money out via ERC-20 `transfer`.** | ARC §3, §5 |
| 3 | **LP is locked, never burned.** Arc reverts value transfers to `0x0`. | ARC §4 |
| 4 | **All fees are pull, never push.** | ARC §5, §6 |
| 5 | **Every time window is counted in `block.number`.** | ARC §8 |

### Decision 2 is the one worth dwelling on

On Arc the native balance and the USDC ERC-20 balance are the *same funds*. So:

```solidity
function buy(...) external payable        // msg.value, 18-dec — NO approve needed
function sell(...) external               // pays out via USDC.transfer, 6-dec
```

**Buying is one transaction with no approve step.** No other USDC launchpad on any chain
can do that — everywhere else USDC is an ERC-20 and buying costs approve + swap, or a
permit dance. Here it is exactly as frictionless as pump.fun with SOL, while being priced
in dollars.

Paying *out* deliberately does **not** use `call{value:}`. A native send to a contract on
Arc can revert for reasons the recipient does not control (ARC §5), and one such recipient
would brick the function for everybody. A plain ERC-20 `transfer` invokes no callback and
is the safe direction.

**Accounting rule.** The curve accounts in native 18-decimal units. At migration it pays the
pair `floor(balance / 1e12)` in 6-decimal ERC-20 units. The sub-`1e-6` USDC remainder is
permanently stranded in the curve — it cannot be burned (ARC §4) and is worth less than
one millionth of a dollar. This is documented, not fixed. **Every rounding goes to the
pool, never to the user.**

---

## 1. Contract map

```
                        ProtocolConfig ── FeeConfig ── FeeVault
                              │                          ▲ (pull)
                              ▼                          │
                        HexaFactory ──────────────────────
                         │   │   │
        ┌────────────────┘   │   └────────────────┐
        ▼                    ▼                    ▼
    HexaToken            HexaCurve            LaunchGuard
    (ERC-20,            (EIP-1167 clone,     (anti-snipe, library
     fixed supply)       one per launch)      called by curve)
                             │
                          seal()
                             ▼
                      LiquidityMigrator  ──atomic──►  HexaPair (AMM)
                                                          │ LP
                                                          ▼
                                                  LiquidityLocker
                                                   (no withdraw path)
                             HexaRouter ──► HexaPair / HexaCurve
```

**Watch-one-address property.** Every launch is created by `HexaFactory`. The indexer
subscribes to one address and never has to discover contracts by scanning. This is the
specific failure mode that stalled the Oculopus indexer, designed out from the start.

---

## 2. Launch lifecycle

```
NONE
 │ commit(commitHash)                    ← metadata still secret
 ▼
COMMITTED ──── expires after COMMIT_TTL ────► EXPIRED
 │ reveal(params, salt)                   ← token + curve deployed here
 ▼
CURVE_LIVE ◄── buy() / sell() ──┐
 │                              │
 │ raised >= graduationTarget   │
 ▼                              │
SEALED  (curve frozen, no trading)
 │ migrate()  — atomic, permissionless
 ▼
GRADUATED  → HexaPair live, LP in locker forever
```

`EXPIRED` exists so an abandoned commit cannot squat a hash forever. There is no `FAILED`
state and no refund path: a bonding curve is always solvent by construction — every token
in circulation was paid for into the same curve that can buy it back. Refund logic would
be dead code (and dead code in a payable contract is a liability).

---

## 3. `HexaFactory`

Single entry point. Owns the clone template and the launch registry.

```solidity
enum Phase { NONE, COMMITTED, EXPIRED, CURVE_LIVE, SEALED, GRADUATED }

struct Launch {
    address curve;          // EIP-1167 clone
    address token;
    address creator;
    uint64  commitBlock;
    uint64  revealBlock;    // 0 until revealed
    Phase   phase;
}

mapping(bytes32 => Launch) public launches;   // commitHash => Launch
mapping(address => bytes32) public byToken;
address public immutable curveTemplate;
address public immutable pairTemplate;
uint64  public constant COMMIT_MIN_BLOCKS = 12;    // ~ a few seconds on Arc
uint64  public constant COMMIT_TTL_BLOCKS = 7200;
```

### `commit(bytes32 commitHash) external`

Stores `commitHash` with `commitBlock = block.number`. **Nothing about the token is
revealed** — not the name, not the symbol, not the image, not the supply.

```
commitHash = keccak256(abi.encode(
    creator, name, symbol, metadataURI, totalSupply, curveParams, salt
))
```

### `reveal(LaunchParams p, bytes32 salt) external`

1. Recompute the hash, `require` it matches a `COMMITTED` launch.
2. `require(block.number >= commitBlock + COMMIT_MIN_BLOCKS)` — a bot that sees the reveal
   in the mempool cannot retroactively have been in the commit.
3. `require(block.number <= commitBlock + COMMIT_TTL_BLOCKS)`.
4. Deploy `HexaToken` and the `HexaCurve` clone with `CREATE2`, salt derived from
   `commitHash`. The address is a function of a secret, so it is **not precomputable
   before reveal**.
5. Mint the entire supply to the curve. The token has **no mint function afterwards**.
6. Emit `Launched`.

**Why this is the right anti-snipe primitive on Arc.** Arc has a public mempool with FCFS
ordering and no MEV protection (ARC §7). A bot *can* see and race the reveal transaction.
What it cannot do is decide, in the milliseconds it has, whether this unknown token is
worth buying — because until the reveal lands, the name, the image, and the address are all
unknown. Commit-reveal does not stop a bot from being fast; it stops speed from being
worth anything. And because Arc's ordering is FCFS rather than a gas auction, a bot cannot
buy its way to the front either.

**Honest limits.** A bot that indiscriminately buys *every* reveal still gets in at block 0.
That is what §5's decaying sell tax is for. Layer 1 removes the information advantage;
layer 2 removes the profit. Neither alone is sufficient, and no on-chain mechanism is
airtight — say so in the docs rather than claiming "snipe-proof".

### Events

```solidity
event Committed(bytes32 indexed commitHash, address indexed creator, uint64 block);
event Launched(bytes32 indexed commitHash, address indexed token, address indexed curve,
               address creator, string name, string symbol, string metadataURI);
event Sealed(address indexed token, uint256 raisedNative, uint64 block);
event Graduated(address indexed token, address indexed pair, uint256 lpLocked);
```

---

## 4. `HexaCurve`

One clone per launch. Holds the entire token supply and all raised USDC.

```solidity
struct Curve {
    uint128 virtualNative;      // 18-dec, price-setting only
    uint128 virtualTokens;      // 18-dec
    uint128 realNative;         // 18-dec, actually held
    uint128 realTokens;         // 18-dec, left to sell
    uint128 graduationTarget;   // 18-dec native raised that seals the curve
    bool    sealed_;
}
```

Invariant: `k = virtualNative * virtualTokens` is constant across `buy`/`sell`, evaluated
before fees. Virtual reserves set the opening price; real reserves decide graduation.

### `buy(uint256 minTokensOut, address to) external payable`

```
1  require phase == CURVE_LIVE
2  fee      = msg.value * buyFeeBps / 10_000
3  netIn    = msg.value - fee
4  out      = virtualTokens - k / (virtualNative + netIn)      // round DOWN
5  LaunchGuard.checkBuy(to, out)                                // §5
6  require(out >= minTokensOut)                                 // slippage
7  virtualNative += netIn; virtualTokens -= out
   realNative    += netIn; realTokens    -= out
8  FeeVault.credit(...)                                         // accrue, do not send
9  token.transfer(to, out)
10 if (realNative >= graduationTarget) _seal()
```

No refund leg. Exact-in only — there is nothing to send back, so there is no push payment
to fail (ARC §5).

> **The buy that finishes the curve is capped, not reverted.** An earlier draft reverted with
> `ExceedsCurveSupply` so the frontend could retry with an exact amount. Integration testing
> showed that was unshippable: with output rounded down in the pool's favour, **no input
> lands `realTokens` on exactly zero**, so graduation was unreachable and the most important
> buy of a launch always failed. `buy()` now caps the output at the remainder, as pump.fun
> does. Overpayment is caught by `minTokensOut`, which every caller already sets, and any
> surplus stays in the curve and ends up in the pool.
>
> `maxBuyIn()` remains as a frontend helper and rounds **down** for the same reason.

### `sell(uint256 amountIn, uint256 minNativeOut, address to) external`

Mirror image. Proceeds leave as `USDC.transfer(to, floor(out/1e12))` in 6-decimal units,
**not** `call{value:}`. The truncated remainder stays in the curve.

`LaunchGuard.checkSell` applies the decaying tax; the tax is credited to `FeeVault`, never
transferred inline.

### Creator cap — enforced inside `buy()`, not in a separate entry point

Capped at `creatorMaxBps` of supply, recorded in the public `creatorHeld`.

> **Implementation note.** An earlier draft put this in a dedicated `creatorBuy()`. That was
> wrong: the creator could simply call the ordinary `buy()` and skip the cap entirely. A cap
> the capped party can route around is not a cap. The check now lives in `buy()` itself,
> keyed on the recipient.

Not prohibition — **disclosure**. Pump.fun's real failure was never that founders bought
their own launch; it was that they did it from an unlabelled second wallet and the UI had
no idea. Here the number is on-chain and the card renders "creator holds 2.4%" whether
the creator likes it or not. A creator buying from an unrelated wallet is still possible
and still invisible; per-wallet caps (§5) are what bound the damage.

### Referrals

Single-tier, first-touch, per token. `mapping(address trader => address referrer)` is
written once on a trader's first trade and never changes. Full rationale and the
limits — self-referral, and why attribution cannot survive graduation — are in
[FEES.md](FEES.md).

---

## 5. `LaunchGuard` — anti-snipe

Pure functions over immutable per-launch params. No storage of its own beyond counters.

```solidity
struct GuardParams {
    uint64  guardBlocks;      // per-wallet cap active for this many blocks after reveal
    uint64  taxBlocks;        // sell tax decays to floor over this many blocks
    uint16  maxBuyBps;        // per-wallet cap during guard, e.g. 50 = 0.5% of supply
    uint16  sellTaxStartBps;  // e.g. 9000 = 90%
    uint16  sellTaxFloorBps;  // e.g. 100 = 1%
    uint16  creatorMaxBps;    // e.g. 300 = 3%
}
```

All windows are **block counts, never timestamps** — Arc's sub-second blocks share
timestamps and `block.timestamp` is only non-decreasing (ARC §8). Because blocks are
sub-second, these counts must be large: a 5-minute tax decay is on the order of
**hundreds of blocks**, not the 25 that Ethereum intuition suggests. Calibrate against
measured Arc block rate before mainnet, and store the numbers in `ProtocolConfig` so they
can be tuned without redeploying the curve template.

### The decaying sell tax

```
elapsed = block.number - revealBlock
tax(bps) = elapsed >= taxBlocks
         ? sellTaxFloorBps
         : sellTaxStartBps - (sellTaxStartBps - sellTaxFloorBps) * elapsed / taxBlocks
```

Linear, monotonic, and cheap. Buying early is **never blocked** — blocking early buyers is
what allowlists do, and allowlists just move the game to who gets allowlisted. Instead the
first seconds are a terrible time to *flip*, and a perfectly good time to *hold*. That is
precisely the incentive a fair launch wants, and it needs no off-chain gatekeeper.

Tax revenue does not go to the protocol treasury. It is credited to the **curve itself**,
which means it raises the floor for everyone still holding. A snipe becomes a subsidy.

> Design note: a per-wallet cap alone is defeated by splitting across wallets, and Arc gives
> us no sybil resistance to lean on. The cap is there to bound a single actor's blast
> radius, not to stop them. The tax is the part that actually works, because splitting
> wallets does not reduce it.

---

## 6. `HexaPair` + `LiquidityMigrator`

> **Decided 2026-08-12: Uniswap v3, at the 1% fee tier.** Built as
> `LiquidityMigrator.sol` + `LiquidityLocker.sol`. The v3 factory address is a constructor
> argument, never a constant — Arc testnet has no Uniswap and needs a self-deployed v3
> fixture, while mainnet has Uniswap's canonical deployment and a parallel pool there would
> split liquidity against it. [CURVE.md §5](CURVE.md).

The pool is over `(HexaToken, USDC@0x3600…)`. No wrapped-native contract is needed — on Arc
there is nothing to wrap (ARC §3) — and no v3-periphery either, since Hexapus never manages
a position after creating it. That avoids periphery's WETH9 dependency entirely.

`migrate(token)` is permissionless and atomic: release from the curve → create pool →
initialize at the curve's closing price → mint full-range to the locker → record. A
privileged keeper would mean a keeper outage freezes every graduated coin.

**Fees after graduation come from the pool's own fee tier, not from a router.** A
router-level fee on an open pool is bypassed by calling the pool directly; a fee charged by
the pool itself cannot be. Since 100% of the liquidity is ours and locked, 100% of those
fees are ours to split.

### `migrate(address token) external` — permissionless, atomic

```
require phase == SEALED
amount6 = floor(curve.realNative / 1e12)
create pair (CREATE2, deterministic from token)
USDC.transfer(pair, amount6)          ← ERC-20 leg, 6-dec
token.transfer(pair, curve.realTokens)
pair.mint(address(liquidityLocker))   ← LP goes straight to the locker, never to us
phase = GRADUATED
```

Any failing step reverts the whole call. There is no partial state where a token is sealed
with its liquidity half-moved — the failure mode that has bitten every launchpad that
sequenced migration across multiple transactions.

Permissionless on purpose: if migration required a privileged keeper, then a keeper outage
freezes every graduated token. Anyone can pay the gas.

---

## 7. `LiquidityLocker`

```solidity
mapping(address pair => address feeRecipient) public creatorOf;

function collectFees(address pair) external;   // splits per FeeConfig, credits FeeVault
// there is deliberately no withdraw, no unlock, no emergency exit,
// no owner-only escape hatch, and no upgrade path on this contract.
```

The contract is **not upgradeable and has no admin**. This is the one place where
immutability is the product: "LP is locked" is only worth saying if there is no code path
that could ever unlock it — not a timelock, not a multisig, not a governance vote.

On Arc this is also the *only* option, since burning is impossible (ARC §4). What other
chains achieve by sending LP to `0x0`, Hexapus achieves by never writing the withdraw
function.

---

## 8. `FeeVault` — pull only

```solidity
mapping(address => uint256) public owed;        // 18-dec native accounting

function credit(address to, uint256 amount) external onlyProtocol;  // internal accrual
function claim() external;                       // USDC.transfer(msg.sender, owed/1e12)
```

`claim()` is the only function that moves money out, and the caller is always the
beneficiary — so a blocklisted or hostile recipient can only ever break *their own* claim,
never anyone else's buy (ARC §5, §6).

Fee splits (protocol / creator / referrer) live in `FeeConfig`, a separate contract behind
`ProtocolConfig`. **Recipients are never hardcoded into the curve.** Pump.fun had to ship
breaking changes to its fee-recipient accounts twice; that is a cheap lesson to learn from
someone else.

---

## 9. Invariants to test

Against a **live Arc RPC**, not a local fork — `anvil` does not implement Arc's rules and
will pass tests that Arc fails (ARC §9).

1. `virtualNative * virtualTokens` is constant across buy/sell, pre-fee.
2. Curve solvency: `realNative >= Σ(what every holder could sell for)`, at all times.
3. Every rounding error favours the pool. Fuzz buy/sell round-trips; a user must never end
   up with more than they started with.
4. Sum of `FeeVault.owed` never exceeds the vault's claimable balance.
5. `reveal` is impossible before `COMMIT_MIN_BLOCKS`, and impossible after `COMMIT_TTL`.
6. Sell tax is monotonically non-increasing in `block.number` and never below the floor.
7. `migrate` is all-or-nothing: no execution path leaves `SEALED` with liquidity moved.
8. `LiquidityLocker` has no reachable code path that decreases its LP balance. Assert this
   by bytecode review, not only by unit test.
9. **Blocklist behaviour**: a blocklisted buyer's `buy` reverts; a blocklisted *creator*
   does **not** prevent anyone else from buying, selling, or migrating. This is the single
   most important Arc-specific test and it cannot be written against `anvil`.
10. Native dust: sending `msg.value` that is not a multiple of `1e12` must not revert, must
    not credit the sender extra, and must leave the surplus in the pool.

---

## 10. Open questions

1. **Curve parameters.** `virtualNative`, `virtualTokens`, `graduationTarget`. Pump.fun's
   are tuned for SOL volatility and a $69k graduation. Denominated in dollars on Arc the
   numbers should probably be different, and they should be argued from first principles
   rather than copied.
2. **Block-rate calibration.** Every guard window depends on Arc's real block rate under
   load. Measure it; do not trust "sub-second".
3. **Fee split.** Not decided. Deliberately left to `FeeConfig` so it does not block
   contract work.
4. **Does Hexapus list non-Hexapus tokens for trading, or only index them?** Indexing every
   Arc token (the Explore leaderboard) is settled. Routing swaps for tokens launched
   elsewhere is a much larger surface and is not specified here.
5. **Upgradeability.** `LiquidityLocker` must be immutable (§7). `HexaFactory` probably
   should not be. The boundary needs deciding before deployment, not after.
