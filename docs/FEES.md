# Fees and referrals

## Creation fee

**0.5 USDC per launch**, charged on `reveal()` and configurable by the owner
(`setCreationFee`). It is added on top of any buy-in: a launch with no buy-in sends exactly
the fee, one with a buy-in sends fee + amount, and the contract splits them.

Charged on reveal rather than commit on purpose. A commit that is never revealed produces no
coin, and putting a price on it would charge for nothing — it already costs its sender gas.

The fee goes to the treasury through the same vault as everything else, so it is pulled with
`claim()`, never pushed.

## Trading fee

Total: **1%** of the quote leg (USDC), on both buy and sell.

## Split

| | Protocol | Creator | Referrer |
|---|---|---|---|
| Trade **with** a referrer | 20% | 60% | 20% |
| Trade **without** a referrer | 30% | 70% | — |

Shares are of the **1% fee**, not of the trade. On a $1,000 buy the fee is $10, split
$2 / $6 / $2.

The unclaimed referral share is **split** when a trade has no referrer, rather than handed to
either side. Giving it all to the protocol would make Hexapus prefer trades that arrive without
a link; giving it all to the creator would make the creator prefer the same. Splitting it leaves
neither with a reason to care.

> Revised 2026-09-04 from 40/40/20 and 50/50. Creators keep more of both phases.

## Referral model: single-tier, first-touch, per token

Exactly the model described in the brief, and it is straightforward on-chain.

```
A creates DOGE.
B trades with no referral link          → fee splits 50 protocol / 50 creator
B shares a DOGE referral link with C
C trades through that link              → 40 protocol / 40 creator (to A) / 20 to B
C shares their own link with D
D trades                                → 40 protocol / 40 creator (to A) / 20 to C
                                          B gets nothing from D. Single tier only.
```

### Storage

```solidity
// inside HexaCurve — one curve is one token, so this is already per-token
mapping(address trader => address referrer) public referrerOf;
```

Attribution is **first-touch and permanent**: the referrer is recorded on a trader's first
trade of that token and never changes. Two reasons:

1. A later referrer cannot steal attribution from the person who actually did the work.
2. It costs one storage write per (token, trader) instead of one per trade.

Per-token rather than global is deliberate — people share *a specific coin*, and the same
trader can legitimately be introduced to different coins by different people.

### What this model cannot prevent

**Self-referral.** A trader can pass their own second wallet as referrer and keep the 20%.
On-chain there is no way to tell two wallets apart, and Arc offers no sybil resistance to
lean on. `referrer != msg.sender` blocks only the lazy version.

This is worth being straight about rather than engineering against: the worst case is that
a sophisticated user pays 0.8% instead of 1%. Every referral programme in the industry has
this property. It is a 20-basis-point discount for people who bother, not an exploit.

The creator referring their own audience is not an exploit either — they earn 60% + 20% =
80% for doing the marketing. That is the system working.

### Where referrals stop working

**After graduation, referral attribution ends.** This is a real limitation, not an
oversight.

Post-graduation, fees come from the AMM pool's own fee tier (see
[CURVE.md §5](CURVE.md)), because a router-level fee on an open pool is trivially
bypassed by calling the pool directly. Pool fees accrue **in aggregate** to the liquidity
position — there is no per-trade record to attribute, and no way to know which swap came
from whose link.

So:

| Phase | Fee source | Referral works? |
|---|---|---|
| Bonding curve | Our contract, per-trade | ✅ 20/60/20 |
| After graduation | Pool fee tier, aggregate | ❌ 30/70 protocol/creator |

Any launchpad advertising lifetime referral revenue on an open AMM pool is either routing
all volume through a bypassable router, or not being precise. Hexapus should say plainly
that referral rewards apply to the launch phase.

## Payout mechanics

All three parties accrue into `FeeVault` and **pull** with `claim()`. Nothing is pushed.

On Arc, pushing native value to a contract can revert for reasons the sender does not
control, and a blocklisted address reverts at runtime — so a push-based split would let one
bad recipient brick every trade on that token. With pull, a hostile or blocklisted
recipient can only ever break their own `claim()`.

```solidity
mapping(address => uint256) public owed;   // 18-dec native accounting
function claim() external;                 // USDC.transfer(msg.sender, owed / 1e12)
```

## Routing swaps for tokens launched elsewhere

Confirmed in scope, with a protocol fee.

The router charges its fee on the **output leg** and accrues it to `FeeVault` like any
other fee. Creator and referrer shares do not apply — Hexapus did not launch the token and
has no creator to pay — so the whole cut goes to the protocol.

**Caveat on timing, and a correction.** Arc's external liquidity today is one community
Uniswap V2 deployment with a USDC/EURC pair, so *aggregating other Arc venues* has nothing
to aggregate yet. Build the adapter interface pluggable and spend no real effort there until
venues exist.

That is **not** true of the swap page as a whole. Its primary job is
any-chain USDC → Arc token via the unified balance, which is the acquisition channel and is
valuable from day one — every user's capital starts on another chain. See [SWAP.md](SWAP.md).

---

## Planned: 20 / 70 / 10 with permanent referral

**Decided 2026-09-04. Not shipped — blocked on Uniswap v4 reaching Arc.**

| | Protocol | Creator | Referrer |
|---|---|---|---|
| Trade **with** a referrer | 20% | 70% | 10% |
| Trade **without** a referrer | 25% | 75% | — |

The referrer's share becomes **permanent**: it keeps paying after the coin graduates, not just
during the launch phase.

### Why it cannot ship yet

Everything above §"Where referrals stop working" still holds **on Uniswap v3**. Pool fees accrue
in aggregate to the liquidity position, with no per-trade record, so there is nothing to attribute
a post-graduation swap to.

A **Uniswap v4 hook** sees every swap individually, which is exactly the missing piece — so
permanent referral is a v4 feature, not a v3 one that we failed to build. Checked
2026-09-04 with `eth_getCode` against the canonical v4 PoolManager on Arc testnet: **no code**.
Only the v3 factory this project deploys itself.

### The gate

Arc's public mainnet is **2026-09-16**. On that date, check whether Uniswap v4 is deployed there:

```
eth_getCode 0x000000000004444c5dc75cB358380D2e3dE08A90
```

- **v4 present** → rebuild the migrator and locker against v4 with a fee hook, move the split to
  20/70/10, and let referral survive graduation.
- **v4 absent** → keep v3 and either ship 20/70/10 as a launch-phase-only split, or hold the whole
  change until v4 arrives. Shipping "permanent referral" on v3 is not an option; it would be a
  claim the contracts cannot keep.

Either way this is a **factory redeploy**: the shares are `private constant` in `HexaCurve` and
`curveTemplate` is `immutable` with no setter, so there is no way to change them in place.
