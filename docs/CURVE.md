# Curve parameters — what the others use, and what Hexapus should use

Sources are cited inline. Numbers not cited are derived here and the derivation is shown.

---

## 1. Pump.fun — the exact constants

From the Pump SDK's bonding-curve documentation:

| Constant | Raw value | In whole tokens / SOL |
|---|---|---|
| Initial **virtual** token reserves | `1_073_000_000_000_000` | 1,073,000,000 |
| Initial **virtual** SOL reserves | `30_000_000_000` lamports | 30 SOL |
| Initial **real** token reserves | `793_100_000_000_000` | 793,100,000 |
| Total supply | `1_000_000_000_000_000` | 1,000,000,000 |
| Decimals | 6 | — |

Graduation is **not** a market-cap check. The curve completes when `realTokenReserves`
hits zero — i.e. when all 793.1M sellable tokens are gone. The remaining
`1B − 793.1M = 206.9M` tokens (20.69%) are never sold on the curve; they are the LP side
at migration.

### Where "85 SOL" comes from

Constant product on the **virtual** reserves:

```
k = 1,073,000,000 × 30 = 32,190,000,000

After all 793.1M real tokens are sold:
  virtualTokens_end = 1,073,000,000 − 793,100,000 = 279,900,000
  virtualSol_end    = k / 279,900,000            = 115.0054 SOL
  SOL raised        = 115.0054 − 30              = 85.005 SOL
```

The famous 85 SOL is not a configured threshold. **It is a consequence of the two reserve
numbers.** Nobody typed 85 anywhere.

### Where "$69k" comes from

```
start price = 30 / 1,073,000,000        = 0.000000027959 SOL
end price   = 115.0054 / 279,900,000    = 0.000000410880 SOL
```

At 1B supply, end market cap = `0.00000041088 × 1e9 = 410.88 SOL`.
At SOL ≈ $168 that is **$69,028**. The $69k is a marketing number that only holds at one
SOL price — at SOL $150 it is $61.6k. **This is exactly the flaw Arc fixes.**

### The single most useful fact about this curve

```
price multiple = (virtualTokens / (virtualTokens − realTokens))²
               = (1,073 / 279.9)²
               = 3.8335²
               = 14.70×
```

The multiple from launch to graduation depends **only on the ratio** of the two token
numbers. The virtual SOL reserve does not appear. So:

> **The token reserves set the *shape* of the curve. The quote reserve only sets the
> *scale* in dollars.**

That separation is what makes these parameters tunable without guesswork — pick the shape
once, then move one number to set how much money a graduation represents.

---

## 2. Virtuals Protocol

- Total supply **1,000,000,000** per agent token.
- Bonding curve denominated in **$VIRTUAL**, not the chain's gas token.
- Graduates at **42,000 VIRTUAL** raised, then a Uniswap pool is created pairing the agent
  token with VIRTUAL.
- **Liquidity locked for 10 years.**

The interesting choice is denominating in a *project* token rather than SOL/ETH. It forces
demand for VIRTUAL and makes every launch a bid on the platform token. It also means every
agent token inherits VIRTUAL's volatility on top of its own — the same double-volatility
problem as pump.fun, self-inflicted.

Hexapus has no reason to copy this. USDC as the quote asset is strictly better for traders,
and Arc gives it for free.

---

## 3. NOXA — a genuinely different model

NOXA runs on **Robinhood Chain**, and it has **no bonding curve contract at all**:

1. Deploy the ERC-20.
2. Add **single-sided liquidity** to a **Uniswap V3 pool at the 1% fee tier**.
3. Token is tradeable on the DEX immediately.
4. The LP position is locked permanently in a locker. **There is no migration.**
5. "Graduation" is a UI milestone based on net buy volume, not a state transition.

### Why single-sided V3 liquidity behaves like a bonding curve

A V3 position holding only the token, in a tick range entirely above the current price, is
sold off progressively as the price climbs through the range. Buyers walk up the range;
the position converts token → quote asset as they do. That *is* a bonding curve — just
expressed as a range order on a real AMM instead of a bespoke contract.

**This is architecturally cleaner than pump.fun**, and it deletes the single most
dangerous step in the whole design: migration. No `SEALED` state, no atomic multi-step
liquidity move, no half-migrated failure mode. Fees accrue from the very first trade.

### Why Hexapus still cannot simply copy it

Two blockers, both hard:

1. **There is no Uniswap V3 deployed on Arc.** NOXA gets to use Robinhood Chain's existing
   deployment. We would have to deploy V3 ourselves (legal — see §5).
2. **A raw V3 pool cannot enforce anything.** `pool.swap()` is permissionless. A sniper
   calls the pool directly, bypasses your router, and pays neither your protocol fee nor
   your anti-snipe tax.

Point 2 is not a detail. NOXA's own documentation **does not address anti-sniping at all** —
not as an oversight, but because on V3 there is no place to put it. Uniswap V4 hooks exist
precisely to solve this, and V4 is licence-locked until 2027-06-15 (§5).

Since "fair launch, anti-snipe" is the entire premise of Hexapus, the launch phase must be
a contract we control. That is not a stylistic preference — it is the only place the rules
can actually be enforced.

---

## 4. Proposed Hexapus parameters

Keep pump.fun's *shape* — it is well-tested and traders already understand how it feels —
and re-scale the quote side into dollars.

```
totalSupply         = 1,000,000,000     (18 decimals, EVM convention)
virtualTokens_0     = 1,073,000,000
realTokens_0        =   793,100,000     (79.31% sold on the curve)
lpTokens            =   206,900,000     (20.69% seeded into the pool)
virtualUsdc_0       =   see table
```

Because the multiple is fixed at **14.70×** by the token ratios, `virtualUsdc_0` alone
decides every dollar figure:

| `virtualUsdc_0` | Start mcap | Graduation mcap | Buying needed to graduate |
|---|---|---|---|
| $1,000 | $932 | $13,696 | $2,834 |
| **$2,146** ← default | **$2,000** | **$29,392** | **$6,081** |
| $3,000 | $2,796 | $41,088 | $8,500 |
| $5,000 | $4,660 | $68,480 | $14,168 |

All four verified by `npm run contracts:sim`, which replays the contract's integer math.
Migration price drift for the default is **0.0000%** on both token orderings.

### Why $2,000, and what it costs

The open is set to $2,000 because that is the number people compare launchpads on, and every
competitor bakes exactly one into its curve — a scanner showing a column of identical market
caps is showing you that platform's opening constant. pump.fun's own is **~$4,194** (28 SOL
at $150), which drifts every time SOL does; $2,000 on Arc is $2,000 permanently.

**The honest cost:** graduating needs $6,081 of buying, and community reporting puts the
largest memecoin on all of Arc at roughly $10k market cap. On that evidence, most coins at
this size will not graduate soon. That is a deliberate trade — a recognisable open in
exchange for a graduation that is currently out of reach for most launches.

Two things soften it. The size is a **per-launch choice**, so anyone who wants a reachable
graduation picks the $932/$13,696 row from the same dropdown. And the default is protocol
config, not a constant: raising or lowering it later is a setting, not a redeploy.

If reachability ever matters more than the opening number, the lever is the curve *shape*,
not the size — see §6.

Derivation for any `X = virtualUsdc_0`:

```
raised          = X × (1,073.0 / 279.9 − 1) = X × 2.83351
start mcap      = X × (1e9 / 1,073,000,000) = X × 0.93197
graduation mcap = X × 13.696
```

### The 793.1M / 206.9M split is load-bearing — do not round it

The leftover supply is not "whatever is left over". Those two numbers are chosen so the
**pool opens at the price the curve closed at**:

```
curve's closing price = virtualUsdc_0 x 1.369600e-8      (virtualUsdc_end / virtualTokens_end)
pool's opening price  = virtualUsdc_0 x 1.369507e-8      (raised / lpTokens)
                                        ──────────
                                        differ by 0.0068%
```

The leftover tokens, priced against the raised USDC, land within seven thousandths of a
percent of where trading stopped. Verified across all four presets and both token orderings
by `npm run contracts:sim` — drift ≤ 0.0001% after the Q64.96 conversion.

**Anyone "tidying" these to 800M / 200M opens a price gap at migration**, and hands a free
arbitrage to whoever is watching the migration transaction. If the ratios ever change,
re-run the simulation before shipping.

### The thing worth saying in marketing

`Opens at $2,000` is **real dollars on Arc, permanently**. Pump.fun cannot make that
statement about any of its numbers — its opening market cap moves every time SOL moves, even
when nobody trades the token. That is the clearest one-sentence reason to launch on Hexapus
instead, and it costs nothing to deliver because Arc hands it to us.

---

## 5. Which AMM — the licence question, settled

Verified directly from the repositories on 2026-08-11:

| | Licence | Change Date | Becomes |
|---|---|---|---|
| **Uniswap V3 Core** | BUSL-1.1 | **2023-04-01** — *already passed* | **GPL-2.0-or-later** |
| **Uniswap V4 Core** | BUSL-1.1 | **2027-06-15** — *~10 months away* | MIT |

So:

- **V4 is off the table today.** Deploying it commercially before 2027-06-15 violates the
  licence unless covered by the Additional Use Grant published at
  `v4-core-license-grants.uniswap.eth`. That grant should be read before anyone assumes
  otherwise.
- **V3 is free to deploy**, and has been for three years. But it is **GPL-2.0-or-later**,
  which is copyleft — derivative work inherits it. For an open-source launchpad that is
  a non-issue; if any part of Hexapus is meant to stay proprietary, it is a real
  constraint that needs a lawyer, not an engineer.

### Where Uniswap actually is on Arc (verified 2026-08-12)

Probed directly against Arc testnet RPC at the canonical addresses:

| Contract | Arc testnet |
|---|---|
| UniswapV3Factory `0x1F98…F984` | **no code** |
| SwapRouter / SwapRouter02 / NonfungiblePositionManager | **no code** |
| v4 PoolManager `0x0000…8A90` | **no code** |
| Permit2 `0x0000…8BA3` | ✅ 9,152 bytes |
| CREATE2 Factory `0x4e59…956C` | ✅ 69 bytes |
| ArcSwap V2 factory + router (community) | ✅ 13,859 / 21,943 bytes |

**Mainnet is a different story.** Circle's own launch announcement has Uniswap providing
swap infrastructure and liquidity from day one on 2026-09-16, ARCANINE (marketed as the first
meme on Arc mainnet) advertises Uniswap v3 liquidity locked forever, and RadarDex ships a
token launcher built on Uniswap v3. Not verifiable on-chain from here without a mainnet RPC,
but the sources agree.

**So: do not deploy a competing v3 on mainnet.** Uniswap is an official Arc launch partner;
a parallel deployment would split liquidity against the canonical pools, which is the worst
available outcome.

Deploy v3-core on **testnet only**, as a development fixture, so the migration path can be
built and tested now. On mainnet, point at Uniswap's canonical addresses. Same code, two
roles — which means **every Uniswap address must be configuration, never a constant.**

### Recommendation

**Split the problem by phase**, because the two phases have different requirements:

| Phase | Needs | Answer |
|---|---|---|
| Launch / curve | Enforceable anti-snipe and fees | **Custom contract.** No AMM can do this. |
| Post-graduation | Deep, permanent, fee-earning liquidity | AMM — and here V3 is a real option |

The curve contract has to be written either way, and it is where all the anti-snipe value
lives. **Write it first.** The AMM choice only affects what `migrate()` targets, so it can
be decided later without blocking any of the work.

### How fees survive after graduation without a router

Once a token is on an open AMM, a router-level fee is bypassable. The fix is the one NOXA
uses: **charge the fee at the pool's own fee tier**, and own 100% of the LP.

```
every swap  →  pays the pool's 1% fee tier  →  accrues to the LP position
                                             →  the position is ours, locked
                                             →  collect() and split it
```

Unbypassable, because the pool itself charges it. Nobody can route around a fee that is
part of the pool.

The cost: LP fees accrue in aggregate, so they **cannot be attributed to individual
trades** — which means referral attribution does not survive graduation. See
[FEES.md](FEES.md).

---

## 6. Changing the shape, if reachability ever wins

Open and graduation are locked **14.70× apart** by the token ratios. Wanting a higher open
*and* a lower graduation means a smaller multiple, which means new ratios — and they cannot
be picked freely, because the leftover supply has to price itself at exactly the graduation
price or migration opens a gap for someone watching the transaction.

The constraint has a closed form. With `r = virtualTokens / (virtualTokens − realTokens)`:

```
multiple      = r²
virtualTokens = totalSupply · r² / (r² − 1)
realTokens    = virtualTokens · (r − 1) / r
lpTokens      = virtualTokens · (r − 1) / r²
```

Substituting `r = 3.83351` reproduces pump.fun's `1,073,000,000 / 793,100,000 / 206,900,000`
exactly. That is how we know their constants are a *solution* to this constraint rather than
a preference — and that the formula above is right.

For a **6×** curve opening at $2,000 and graduating at $12,000 for $3,479 of buying:

| | |
|---|---|
| `virtualTokens` | 1,200,000,000 |
| `realTokens` | 710,100,000 |
| `lpTokens` | 289,900,000 |
| `virtualUsdc_0` | $2,400 |

**Not adopted** — recorded so that switching is a parameter change with known values rather
than a derivation someone has to redo under pressure. Re-run `npm run contracts:sim` after
changing any of them; the migration drift check is what catches a mistake here.
