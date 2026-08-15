# Arc constraints — what a launchpad can and cannot do

Verified 2026-08-11 against `docs.arc.io`, Circle skill `use-arc`, and Arc ecosystem sources.
Every item here is a **design constraint**, not trivia. Re-verify before mainnet.

---

## 1. Network facts

| Field | Value |
|---|---|
| Type | Independent **L1** (not a rollup) |
| Consensus | Permissioned PoA, regulated-institution validator set, 2-phase voting, >2/3 quorum |
| Chain ID | `5042002` (`0x4CEF52`) |
| RPC / WS | `https://rpc.testnet.arc.network` / `wss://rpc.testnet.arc.network` |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |
| CCTP domain | `26` |
| Finality | Deterministic, **< 1 second, no reorg risk** |
| Block time | Sub-second |
| Public mainnet | **2026-09-16** (private mainnet live now) |

### Deployed contracts on Arc testnet

| Contract | Address |
|---|---|
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CCTP TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |

**No canonical DEX.** Arc docs list no router, no factory, no WETH-equivalent.

---

## 2. 🚨 There is no Uniswap on Arc

The only AMM found on Arc testnet is a community deployment ("Arc Swap", ecosystem
submission `circlefin/arc-node#160`) — a stock **Uniswap V2** copy, frontend hosted on a
Replit dev URL. Not infrastructure anyone should build on.

Uniswap Labs is a *named ecosystem participant* for Arc, but **no v3 or v4 PoolManager is
deployed or documented**.

**Consequence:** Hexapus cannot "migrate to Uniswap" — there is nothing to migrate to.
Hexapus must ship its own AMM.

This is an upgrade, not a setback: it makes Hexapus the DEX, so it earns the **swap fee
stream**, not just launch fees. Bonding-curve launchpads that graduate onto someone else's
AMM give away the durable revenue and keep only the one-time cut.

---

## 3. 🚨 Native USDC is the same balance as ERC-20 USDC

Two views onto **one pool of funds**:

| View | Decimals | Used for |
|---|---|---|
| Native | 18 | gas, `msg.value`, native sends |
| ERC-20 @ `0x3600…0000` | 6 | `balanceOf`, `transfer`, `approve` |

They differ by a factor of `1e12`. A native send and an ERC-20 transfer move identical funds.

> **Confirmed by execution, 2026-08-12.** A curve took $28.34 in through `msg.value` and
> `migrate()` then moved it out with `IERC20(USDC).transfer` — the ERC-20 balance read
> `28335120` against `28335119` needed. Everything downstream of this section rests on that
> being true, and it now rests on a transaction rather than on a documentation page.
> Reproduce with `npm run graduate`.

**What this buys us:** `buy()` can be `payable`. One transaction, **no approve step** — the
same UX pump.fun gets from SOL, which no USDC launchpad on any other chain can match.

**What it costs us:**
- The ERC-20 view **truncates below 1e-6 USDC**. Native dust under `1e12` wei reads as `0`.
  All curve math must round **in favour of the pool**, and migration must sweep dust
  explicitly or it becomes permanently unaccounted.
- Never sum the two views — that double-counts.
- USDC ↔ native is **not** a swap. Reject any such route before it reaches fee logic.
- Never call `decimals()` on a native sentinel (`0xEeee…`, `0x0`) — reverts.

---

## 4. 🚨 You cannot burn on Arc

- Value-bearing transfers to `0x0` **revert** — "Zero address not allowed".
- `SELFDESTRUCT` with a balance **reverts**. Sending to a self-destructed account reverts.
- Base fee is **paid to the block beneficiary, not burned**. Arc has no EIP-1559 burn.

> **Correction (2026-08-12).** This section previously said flatly "you cannot burn on Arc"
> and concluded the pump.fun LP-burn primitive was unavailable here. **That was too strong.**
> Arc's restriction is on **native value transfers**. A token contract's own `_burn`
> bookkeeping, or sending an ERC-20 LP token or a position NFT to `0x0`, is ordinary contract
> state and is unaffected. Competing Arc launchpads do advertise burned LP, and that claim is
> not false.

**What actually follows.** LP should still be **locked** rather than burned, but for a
different reason than originally given: burning a Uniswap v3 position forfeits the fees it
would otherwise keep accruing. A locker with no withdraw path, exposing only
`collectFees()`, keeps the trust property *and* the revenue.

The native restriction stays binding elsewhere — it is why every payout in this system is
pull rather than push (§5), and why no part of the design may rely on destroying value.

---

## 5. 🚨 Pushing native value to contracts is unreliable

Arc docs, verbatim in effect: forwarding native value to contracts can fail — blocklist
enforcement, zero-address rules, transfer restrictions — and this "breaks common DeFi
patterns". Sends to precompile addresses always revert.

**Consequence: every payout must be pull, never push.**

```
❌  buy() { ...; creator.call{value: fee}(""); }     // one bad recipient bricks every buy
✅  buy() { ...; owed[creator] += fee; }             // then creator calls claim()
```

Applies to creator fees, protocol fees, referral fees, and failed-buy refunds. Prefer
exact-in swaps with **no refund leg** at all.

---

## 6. 🚨 Blocklist is enforced at runtime

Circle can blocklist an address; transfers to or from it revert **and consume gas**.

- A blocklisted user's buy/sell reverts. The UI must detect and explain this, not show a
  generic failure.
- If a curve or pool address were ever blocklisted, that token is bricked. No recovery path.
- **Hexapus is not censorship-resistant, and the docs must say so plainly.** Any other claim
  is false advertising on a permissioned chain.

---

## 7. Ordering: public mempool, FCFS, no MEV protection

Arc has a **public transaction pool** with **first-come-first-served** ordering. A rotating
proposer bundles pending transactions. No private mempool and no MEV protection documented.

This cuts both ways:

- ❌ Front-running is possible. Anti-snipe must be enforced **entirely in-contract** —
  no help from the sequencer.
- ✅ FCFS means **no gas-priority auction**. A bot cannot outbid its way to the front, and
  Arc's fee market is exponentially smoothed with bounded min/max, so there is no priority
  fee war. Sniping degenerates to a pure **latency race**, which is far cheaper to blunt with
  commit-reveal than a gas auction would be.

---

## 8. Time and randomness

- `block.timestamp` is **non-decreasing, not strictly increasing**. Sub-second blocks may
  share a timestamp. **Order by `block.number`.**
- **All anti-snipe windows must be measured in `block.number`.** A timestamp-based window is
  unenforceable here.
- Sub-second blocks mean a "20 block" window is a couple of seconds. Windows need to be
  an order of magnitude larger than Ethereum intuition suggests.
- `PREVRANDAO` returns `0` — **no on-chain randomness**. Any design needing entropy must get
  it from a commit-reveal salt, not the chain.
- `BLOBHASH`/`BLOBBASEFEE` return `0`/`1`; blob transactions are rejected.
- `CREATE2` and EIP-2935 block hashes behave exactly as on Ethereum.

---

## 9. Testing

> Foundry's `anvil` runs standard EVM, not Arc's implementation.

Local forks will **not** reproduce blocklist enforcement, native-USDC dual-view behaviour,
EIP-7708 transfer logs, or the zero-address/burn restrictions — i.e. precisely the rules
that can break Hexapus. Every invariant in §3–§6 needs an integration test against a live
Arc RPC, not a local fork.

---

## 10. Indexing

Deterministic sub-second finality with **no reorgs** means the indexer needs **no reorg
handling** — a large simplification. Cursor-based block-range polling is sufficient and
correct.

Native USDC movements emit **EIP-7708 `Transfer` logs from a system address (18 decimals)**.
Do not mix these with ERC-20 `Transfer` logs (6 decimals) — same funds, different scale.

Documented providers: Envio (HyperIndex), Goldsky, The Graph, thirdweb Insight.
Reasonable split: self-hosted node for the Factory-scoped indexer, a provider for
full-network discovery if that ever gets expensive.

---

## 11. Opt-in privacy — not available

Arc Privacy Sector (APS) is **TEE-based** (hardware enclaves + Shamir threshold key sharing),
not ZK. It hides contract state and transaction data; private transactions appear as opaque
precompile calls.

**Status: roadmap, not on testnet.** Do not design against it.

Note for later: APS **disables event logging by default** (events need an explicit
precompile). If Hexapus ever touches APS, the indexer goes blind on those transactions.
