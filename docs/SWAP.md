# Swap, bridge, and the unified balance

## Correction to an earlier note

[FEES.md](FEES.md) closed by saying routing was "close to useless right now" because Arc has
almost no external liquidity. That conflated two different products:

| | What it does | Useful today? |
|---|---|---|
| **Bridge-in / unified balance** | USDC on *any chain* → Arc → buy a coin | ✅ **This is the acquisition channel** |
| Routing between non-Hexapus tokens already on Arc | aggregate other venues on Arc | ❌ Not until there are venues |

The second is what has no market yet. The first is the opposite of useless — it is the only
reason anyone with capital on Base, Arbitrum or Solana can use Hexapus at all on day one.
Arc's public mainnet is 2026-09-16; until capital arrives natively, **every user's money
starts somewhere else.**

## What the unified balance is

Arc's **Unified Balance** treats a user's USDC across every supported chain as a single
balance, and lets them spend it on Arc. Delivered through **App Kit**, built on **Circle
Gateway**.

```
Base       100 USDC
Arbitrum   200 USDC   ─┐
Solana      50 USDC   ─┴─►  Unified Balance: 350 USDC
                                   │
                                   │  spend 250
                                   ▼
                                  Arc  ──►  buy $DOGE
```

## Where it appears in the product

**Profile** — show the per-chain breakdown so the user can see where their USDC actually
sits, and the single spendable total. This is informational, and it is the screen that makes
the rest of the flow believable.

**Swap page** — source is the unified balance, destination is any Arc token. The user never
leaves Hexapus to bridge at another dapp and come back. That round trip is where launchpads
lose people: by the time someone has bridged elsewhere and returned, the coin they wanted has
moved.

**Buy button on any coin** — the same flow inline. This is the one that matters most.

## Why this is where batching pays off

Account abstraction on Arc (ERC-4337, with bundlers and paymasters — see
[Arc docs](https://docs.arc.io/arc/tools/account-abstraction.md)) lets several calls settle
under one signature:

```
1 signature  =  [ Gateway mint USDC on Arc ]  +  [ buy on the curve ]
```

Note what this is **not**: it is not anti-MEV. Batching cannot protect a launch, because Arc
has a public mempool with first-come-first-served ordering — the moment `reveal()` is in the
mempool, the name, the parameters and the deterministic address are all readable, and the
rest is a pure latency race. Anti-snipe lives in the contract (commit–reveal before, decaying
sell tax after), not in transaction packaging.

Batching's real value is here, in removing steps from the buy flow. That is a UX moat, and it
is worth building for its own sake rather than mislabelling it as a security property.

## Fees

- **Hexapus coins** — the 1% trading fee, split per [FEES.md](FEES.md).
- **Coins launched elsewhere** — routed with an additional protocol fee. No creator or
  referrer share applies; Hexapus did not launch the token and there is no creator to pay,
  so the whole cut goes to the protocol.

## Build order

1. Unified balance **read** on Profile — the per-chain breakdown. Cheap, and it is the piece
   that explains the product.
2. Bridge-in → buy, batched. The acquisition channel.
3. Standalone swap page.
4. External-token routing. Wait for venues to exist; keep the adapter interface pluggable so
   this is a plug-in, not a rewrite.
