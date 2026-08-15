# Hexapus

Fair-launch meme launchpad **and AMM** on [Arc](https://arc.io), the chain where USDC is the
native gas token.

Status: **running on Arc testnet, end to end.** Unaudited. Testnet only.

A coin has been launched, bought out, graduated, and migrated into a real Uniswap v3 pool on
Arc, with the liquidity locked in a contract that has no withdraw path:

| | |
|---|---|
| HexaFactory | [`0xa2f6be98…52e9`](https://testnet.arcscan.app/address/0xa2f6be980cb6aaf52278c2667bc77f4bd45152e9) |
| LiquidityLocker | [`0x06845639…25cb`](https://testnet.arcscan.app/address/0x0684563993d4a2f097a8a1d15f6aa590591a25cb) |
| First graduated pool | [`0x9A184EE1…3891`](https://testnet.arcscan.app/address/0x9A184EE1b108B2597D32070c8630183525483891) |

Reproduce the whole path with `npm run graduate` (about $29 of testnet USDC).

## Why this is not a pump.fun port

Arc is different enough that copying a Solana or Ethereum launchpad produces something
broken. Three examples, all verified against the chain rather than assumed:

- **USDC is the gas token, and the native balance is the ERC-20 balance.** Buying is one
  transaction with no approve step — the same friction as pump.fun with SOL, but priced in
  dollars. Market cap does not move because the quote asset moved.
- **Arc cannot burn.** Value transfers to `0x0` revert and `SELFDESTRUCT` with a balance
  reverts, so the "burn the LP" trust primitive does not exist. Hexapus locks LP in a
  contract with no withdraw path instead.
- **There is no Uniswap on Arc.** So Hexapus ships its own AMM, and earns the swap fees
  rather than handing them to someone else's DEX.

Full list: [docs/ARC-CONSTRAINTS.md](docs/ARC-CONSTRAINTS.md).

## Layout

```
docs/ARC-CONSTRAINTS.md   what Arc allows and forbids — read first
docs/SPEC.md              contract specification v0.1
docs/CURVE.md             curve parameters, and how pump.fun / Virtuals / NOXA set theirs
docs/FEES.md              1% fee, 40/40/20 split, single-tier referrals
docs/SWAP.md              unified balance, bridge-in, batching
contracts/                Solidity — compiles clean, unaudited, never run on Arc
indexer/                  Arc indexer (viem + sqlite + express) + trending algorithm
site/                     Home + Explore, animated logo
test/integration.mjs      end-to-end against anvil + real Uniswap v3-core
```

## Verify

```bash
npm run typecheck && npm test        # trending algorithm, 7 tests
npm run contracts:build              # solc 0.8.28, 0 warnings
npm run contracts:sim                # curve + migration math
anvil --port 8545 --silent &         # then:
npm run test:integration             # commit -> graduate -> migrate -> locked, 21 checks
npm run graduate                     # the same path on Arc itself, 10 checks, ~$29
```

`test:integration` runs on anvil, which is a standard EVM and cannot reproduce Arc's
native/ERC-20 USDC duality, blocklist enforcement, or burn restrictions. `graduate` is the
one that proves those, because it runs on Arc.

## Indexer

Two roles. **The site only needs the first one.**

| Role | Watches | Transport | Cost |
|---|---|---|---|
| `hexa` | the Hexapus factory, one address | `eth_subscribe` over WS, cursor backfill on reconnect | ~3 requests/minute idle |
| `network` | every ERC-20 on Arc | block-range polling | heavy — every 429 in this project came from here |

`network` is optional and currently unused by any page. It exists for a future "every token on
Arc" view; until then, leave it off and the whole site runs comfortably inside a public RPC's
quota.

Arc has deterministic sub-second finality with no reorgs, so the cursor never rewinds and
there is no reorg-handling code.

**Why not just webhooks for our own events?** Because "everything goes through our
frontend" is exactly the assumption that breaks: bots call the contract directly — that is
the entire premise of the anti-snipe design — so a frontend-only data path would be wrong
precisely for the hottest coins. Webhooks also cannot be a source of truth: they can be
missed, duplicated or reordered, and any downtime loses events permanently unless there is
backfill, which is an indexer. A WebSocket log subscription gives the same latency with the
chain as the source, and watching one address is nearly free.

Webhooks still have a job — **user-facing notifications** ("your coin graduated"). That is a
different problem from knowing what is true.

```bash
copy .env.example .env
npm install
npm run indexer:hexa         # this is the only one the site needs
```

`copy` is Windows CMD. On PowerShell use `Copy-Item`, on bash `cp`.

The RPC is a **fallback chain** across four public Arc endpoints, so a 429 or an outage at one
provider moves to the next instead of failing. Override with `ARC_RPC_URLS` (comma-separated).

| Endpoint | What |
|---|---|
| `/health` | role, cursor, and the chain the RPC actually reports vs the one configured |
| `/tokens` | ERC-20 leaderboard — Explore → Monitoring |
| `/launches` | Hexapus coins and their phase |
| `/booster` | buys made by traders who arrived through a referral link — Explore → Booster |

## Deploy

```bash
node contracts/compile.mjs
RPC_URL=http://127.0.0.1:8545 node scripts/deploy.mjs   # anvil, built-in test key
node scripts/deploy.mjs                                  # Arc testnet, needs .env PRIVATE_KEY
```

Addresses land in `deployments/<chainId>.json`. The script refuses any chain that is not Arc
testnet or anvil, and it will not run without a funded deployer.

On Arc **mainnet**, set `V3_FACTORY` to Uniswap's canonical factory. The script deploys a v3
fixture only where the chain has none, and a parallel deployment on mainnet would split
liquidity against the canonical pools.

Request sizing is measured, not configured: Arc runs ~20-22 Transfer logs per block, and the
RPC caps responses at 10 MB, so each request is sized from the log density the previous one
observed.

## Site

```bash
npm run site        # builds the browser bundle, then serves on :4477
```

| Page | What works |
|---|---|
| Home | live coin count, volume and graduation count from the indexer |
| Explore | 7 tabs, all reading the indexer — no placeholder rows anywhere |
| Create | full commit → wait → reveal flow with MetaMask, optional buy-in |
| Coin | live curve state, buy, sell, referral link, graduation progress |
| Profile | Arc balance, claimable fees with a working claim, your coins |
| Docs | how it works, anti-snipe, fees, graduation, risks |

Swap, bridge and the unified balance are **not implemented** — those pages say so rather
than showing invented numbers.

### Hosting it

`vercel.json` builds the site from the repo root, because the bundle, the ABIs and the
deployed addresses are all generated — deploying `site/` on its own ships a page with no
JavaScript.

Set **`HEXA_API_BASE`** to the public HTTPS origin of your indexer. Without it the build bakes
in `http://127.0.0.1:8880`, and a page served over HTTPS **cannot call an http:// address at
all** — browsers block mixed content, so the site loads and then shows nothing. The indexer
has to be reachable from the internet over TLS before a hosted deployment has any data.

### Why the browser reads through the indexer

Arc's public RPC rate-limits by IP. A coin page wants a dozen values on a timer, so read
directly it returns 429 within seconds and every open tab makes it worse. The indexer polls
once and caches for 5s, so any number of tabs cost what one does. The RPC is still used
directly for quotes and for sending transactions, which have to be live.
