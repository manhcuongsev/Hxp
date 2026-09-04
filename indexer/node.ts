import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getAddress, recoverMessageAddress, type Address, type Log } from 'viem';
import { client, wsClient, config, ARC_CHAIN_ID, loadDeployment, factoryMismatch } from './config.js';
import { openStore } from './store.js';
import { TRANSFER, FACTORY_EVENTS, CURVE_EVENTS, MIGRATOR_EVENTS, ERC20_META } from './abi.js';
import { scoreTrending, scoreMovers, RULES } from './trending.js';
import { packStore, PACK_TYPES, LIMITS } from './packs.js';
import { buildWindows, buildMetrics, decorate, decodeMetadata, imageOf, isBundle, measureBlockRate, blockRate, WINDOWS, type WindowKey } from './aggregate.js';

const store = openStore(config.stateDir);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Contract ABIs from the compiler output, so they can never drift from the deployed code. */
const abiCache = new Map<string, unknown>();
const abiOf = (name: string) => {
  let a = abiCache.get(name);
  if (!a) abiCache.set(name, (a = JSON.parse(readFileSync(`out/${name}.json`, 'utf8')).abi));
  return a;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isFactory = (a: string) => a.toLowerCase() === config.factory?.toLowerCase();

/** All Hexapus events in one topic filter — one request per range instead of three. */
const ALL_EVENTS = [...FACTORY_EVENTS, ...CURVE_EVENTS, ...MIGRATOR_EVENTS];

/**
 * Arc's public RPC answers "Request exceeds defined limit / rate limit exceeded". That is a
 * requests-per-second cap, not a response-size cap — halving the range makes it strictly
 * worse by issuing more requests. Back off in time instead of in size.
 */
const isRateLimit = (e: unknown) =>
  /rate limit|too many requests|429|exceeds defined limit/i.test((e as Error).message ?? '');

/**
 * Decay the backoff toward zero, and actually reach it. Halving alone never does: the value
 * becomes 0.00001 rather than 0, stays truthy, and the next failure doubles *that* instead
 * of restarting at a second — which silently disables the backoff entirely.
 */
const decay = (ms: number) => (ms > 50 ? ms / 2 : 0);

/** Arc has deterministic sub-second finality and no reorgs, so a cursor never rewinds. */
async function resolveStart(): Promise<bigint> {
  const saved = store.cursor(config.role);
  if (saved !== null) return saved + 1n;
  if (config.startBlock > 0n) return config.startBlock;

  // The factory cannot have emitted anything before it existed. Starting at head-5000 on a
  // freshly deployed factory means thousands of pointless requests against a public RPC,
  // which is exactly how the first run got rate limited.
  if (config.role === 'hexa') {
    const chainId = await client.getChainId().catch(() => 0);
    const dep = loadDeployment(chainId);
    if (dep?.deployBlock) {
      log(`starting at the factory's deploy block ${dep.deployBlock} (deployments/${chainId}.json)`);
      return BigInt(dep.deployBlock);
    }
  }

  const head = await client.getBlockNumber();
  const from = head > config.backfillBlocks ? head - config.backfillBlocks : 0n;
  log(`no cursor; starting ${config.backfillBlocks} blocks behind head at ${from}`);
  return from;
}

// ───────────────────────────── event handling ─────────────────────────────

/**
 * Applies one log. Safe to call twice for the same log: launches upsert, and trades and
 * referrals are keyed so a repeat is a no-op. That is what lets the live subscription and
 * the reconciliation pass overlap without double-counting.
 */
function apply(l: Log & { eventName?: string; args?: Record<string, unknown> }): boolean {
  const a = (l.args ?? {}) as Record<string, unknown>;
  const block = l.blockNumber ?? 0n;

  switch (l.eventName) {
    case 'Committed':
      // Address-checked here rather than in the query: everything is fetched in one getLogs
      // now, so the emitter has to be validated per event instead of per subscription.
      if (!isFactory(l.address)) return false;
      store.upsertLaunch(a.commitHash as string, a.creator as string, block);
      return true;

    case 'Launched':
      if (!isFactory(l.address)) return false;
      store.revealLaunch(
        a.commitHash as string, a.token as string, a.curve as string,
        a.name as string, a.symbol as string, a.metadataURI as string, block,
      );
      store.seenToken(getAddress(a.token as string), block, 'hexapus');
      void publishSource(a.token as string);
      return true;

    case 'Migrated':
      store.setPhase(a.token as string, 'GRADUATED');
      return true;

    // Curve events arrive with no address filter, so the emitter has to be checked against
    // the coins we actually launched — any contract can emit a matching signature.
    case 'Bought':
    case 'Sold':
    case 'ReferrerBound':
    case 'Graduated': {
      const token = store.tokenOfCurve(l.address);
      if (!token) return false;

      if (l.eventName === 'Graduated') { store.setPhase(token, 'SEALED'); return true; }

      if (l.eventName === 'ReferrerBound') {
        store.addReferral(token, a.trader as string, a.referrer as string, block);
        return true;
      }

      const isBuy = l.eventName === 'Bought';
      store.addTrade({
        tx: l.transactionHash ?? '',
        logIndex: l.logIndex ?? 0,
        token,
        side: isBuy ? 'buy' : 'sell',
        trader: (isBuy ? a.to : a.seller) as string,
        native: (isBuy ? a.nativeIn : a.nativeOut) as bigint,
        tokens: (isBuy ? a.tokensOut : a.tokensIn) as bigint,
        block,
      });
      return true;
    }
  }
  return false;
}

/**
 * Publish a freshly launched coin's source to the explorer.
 *
 * Every HexaToken shares one bytecode and differs only in constructor arguments, so Blockscout
 * usually marks new ones as matching on its own — this makes it certain rather than likely, and
 * costs one request per launch.
 *
 * Deliberately fire-and-forget: verification is cosmetic, and a slow or unreachable explorer
 * must never stall the log handler that is keeping the index up to date.
 */
const STANDARD_INPUT = 'out/standard-input.json';
const SOLC_VERSION = 'out/solc-version.txt';
const EXPLORER = process.env.ARC_EXPLORER ?? 'https://testnet.arcscan.app';

async function publishSource(token: string): Promise<void> {
  if (!existsSync(STANDARD_INPUT) || !existsSync(SOLC_VERSION)) return;
  try {
    const body = new FormData();
    body.set('compiler_version', 'v' + readFileSync(SOLC_VERSION, 'utf8').trim()
      .replace(/\.Emscripten\.clang$/, ''));
    body.set('contract_name', 'HexaToken.sol:HexaToken');
    body.set('autodetect_constructor_args', 'true');
    body.set('license_type', 'mit');
    body.set('files[0]', new Blob([readFileSync(STANDARD_INPUT)], { type: 'application/json' }),
             'standard-input.json');
    const r = await fetch(
      `${EXPLORER}/api/v2/smart-contracts/${token}/verification/via/standard-input`,
      { method: 'POST', body, signal: AbortSignal.timeout(20_000) },
    );
    log(`verify ${token} -> ${r.status}`);
  } catch (e) {
    log(`verify ${token} skipped: ${(e as Error).message.slice(0, 80)}`);
  }
}

// ───────────────────────────── hexa role ─────────────────────────────

/** Re-read everything between the cursor and head. Covers cold start and dropped frames. */
async function reconcile(): Promise<number> {
  const from = await resolveStart();
  const head = await client.getBlockNumber();
  if (from > head) return 0;

  let applied = 0;
  let cursor = from;
  let chunk = config.chunkSize;
  let backoff = 0;

  while (cursor <= head) {
    const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
    try {
      // Logs arrive in block then index order, which is the order they must be applied in:
      // a Launched always precedes trades on the curve it created, even within one
      // transaction, because the factory emits before it forwards the creator's buy.
      const logs = await client.getLogs({ events: ALL_EVENTS, fromBlock: cursor, toBlock: to });
      for (const l of logs) if (apply(l as never)) applied++;

      store.setCursor(config.role, to);
      cursor = to + 1n;
      backoff = decay(backoff); // recovered; ease off the throttle
      if (backoff) await sleep(backoff);
    } catch (e) {
      if (isRateLimit(e)) {
        backoff = backoff ? Math.min(backoff * 2, 30_000) : 1_000;
        log(`rate limited at ${cursor}-${to}; waiting ${backoff}ms (range unchanged)`);
        await sleep(backoff);
        continue;
      }
      if (chunk <= 25n) throw e;
      chunk = chunk > 50n ? chunk / 2n : 25n;
      log(`reconcile ${cursor}-${to} failed, chunk -> ${chunk}:`, (e as Error).message.slice(0, 120));
    }
  }
  return applied;
}

async function runHexa() {
  if (!config.factory) {
    log('WARN: HEXA_FACTORY_ADDRESS unset — nothing to watch. Set it after deploying.');
    return;
  }

  const first = await reconcile();
  log(`[hexa] backfilled to head, ${first} events applied`);

  const onLogs = (logs: readonly unknown[]) => {
    let n = 0;
    for (const l of logs) if (apply(l as never)) n++;
    const last = (logs.at(-1) as Log | undefined)?.blockNumber;
    if (last) store.setCursor(config.role, last);
    if (n) log(`[hexa] live +${n} event(s) @ ${last}`);
  };
  const onError = (e: Error) => log('[hexa] subscription error:', e.message.slice(0, 120));

  wsClient.watchEvent({ address: config.factory, events: FACTORY_EVENTS, onLogs, onError });
  wsClient.watchEvent({ events: CURVE_EVENTS, onLogs, onError });
  wsClient.watchEvent({ events: MIGRATOR_EVENTS, onLogs, onError });
  log('[hexa] subscribed over WebSocket');

  // A heartbeat so silence is distinguishable from death. Without it, an indexer that has
  // exited looks exactly like one that is running with nothing to report — which is how the
  // first Arc run wasted a debugging cycle.
  setInterval(() => {
    client
      .getBlockNumber()
      .then((head) => {
        const c = store.counts();
        const cur = store.cursor(config.role);
        log(`[hexa] alive  cursor ${cur ?? '-'}  head ${head}  lag ${cur ? head - cur : '?'}  launches ${c.launches}`);
      })
      .catch((e) => log('[hexa] heartbeat failed:', (e as Error).message.slice(0, 100)));
    // Deliberately NOT unref'd: a referenced timer is one more thing holding the event loop
    // open, which is exactly the symptom being guarded against.
  }, config.heartbeatMs);

  // The subscription is the fast path, never the authority: a reconnect can silently skip
  // frames, so the gap between cursor and head is re-read on a timer regardless.
  setInterval(() => {
    reconcile()
      .then((n) => n && log(`[hexa] reconcile recovered ${n} missed event(s)`))
      .catch((e) => log('[hexa] reconcile failed:', (e as Error).message.slice(0, 120)));
  }, config.reconcileMs);
}

// ───────────────────────────── network role ─────────────────────────────

/** Discover every ERC-20 on Arc by its Transfer logs, regardless of who launched it. */
async function scanNetwork(from: bigint, to: bigint) {
  const logs = await client.getLogs({ event: TRANSFER, fromBlock: from, toBlock: to });
  for (const l of logs) store.seenToken(getAddress(l.address), l.blockNumber ?? from);
  return { logs: logs.length };
}

/**
 * Fill in metadata for discovered contracts. Anything that does not answer like an ERC-20 is
 * marked enriched with null fields and drops out of the leaderboard — which is also how
 * Arc's EIP-7708 native transfer logs (system address, 18 decimals) get filtered out
 * without hardcoding that address.
 */
async function enrich(limit = 40) {
  const pending = store.pending(limit);
  if (!pending.length) return 0;
  const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  await Promise.all(
    pending.map(async (addr) => {
      const address = addr as Address;
      const [name, symbol, decimals, supply] = await Promise.all([
        safe(client.readContract({ address, abi: ERC20_META, functionName: 'name' })),
        safe(client.readContract({ address, abi: ERC20_META, functionName: 'symbol' })),
        safe(client.readContract({ address, abi: ERC20_META, functionName: 'decimals' })),
        safe(client.readContract({ address, abi: ERC20_META, functionName: 'totalSupply' })),
      ]);
      store.enrich(
        address,
        typeof name === 'string' ? name : null,
        typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 32 ? symbol : null,
        typeof decimals === 'number' ? decimals : null,
        supply != null ? String(supply) : null,
      );
    }),
  );
  return pending.length;
}

async function runNetwork() {
  let cursor = await resolveStart();
  let chunk = config.chunkSize;
  // The RPC limit is on logs per response, not blocks per request, and Arc's log density
  // swings block to block (~20-22 Transfers/block observed, bursting higher). Size each
  // request from the density the previous one measured, rather than ratcheting a block
  // ceiling down on transient failures and never recovering.
  const TARGET_LOGS = 2_000n;
  let backoff = 0;

  for (;;) {
    try {
      const head = await client.getBlockNumber();
      if (cursor > head) {
        await enrich();
        await new Promise((r) => setTimeout(r, config.pollMs));
        continue;
      }
      const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
      const r = await scanNetwork(cursor, to);

      store.setCursor(config.role, to);
      const c = store.counts();
      log(`[network] ${cursor}→${to} (${Number(to - cursor) + 1} blk) logs=${r.logs} tokens=${c.tokens} enriched=${c.enriched}`);

      const blocks = to - cursor + 1n;
      let next = (blocks * TARGET_LOGS) / BigInt(Math.max(r.logs, 1));
      if (next > chunk * 2n) next = chunk * 2n; // ramp up gently, never leap
      chunk = next < 25n ? 25n : next > config.chunkSize ? config.chunkSize : next;

      cursor = to + 1n;
      backoff = decay(backoff);
      if (backoff) await sleep(backoff);
      await enrich();
    } catch (e) {
      // Unlike the factory-scoped scan, this one really can exceed the response size — it
      // pulls every Transfer on the chain. So both failure modes are live here, and they
      // want opposite responses: shrink the range for size, wait for rate.
      if (isRateLimit(e)) {
        backoff = backoff ? Math.min(backoff * 2, 30_000) : 1_000;
        log(`[network] rate limited at ${cursor}; waiting ${backoff}ms (range unchanged)`);
        await sleep(backoff);
      } else {
        chunk = chunk > 50n ? chunk / 2n : 25n;
        log(`[network] scan failed, chunk -> ${chunk}:`, (e as Error).message.slice(0, 140));
        await sleep(800);
      }
    }
  }
}

// ───────────────────────────── api ─────────────────────────────

const app = express();

// The site is served from a different port, so every fetch is cross-origin. Read-only
// public data, so a permissive header is fine and the alternative is a proxy nobody needs.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // /upload sends an image content-type, which is not CORS-safelisted, so the browser sends a
  // preflight first and refuses the upload unless that header is named here. Express's default
  // OPTIONS handler answers 200 without it, which fails only in a browser — curl never notices.
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); return res.sendStatus(204); }
  next();
});

app.get('/health', async (_req, res) => {
  const head = await client.getBlockNumber().catch(() => null);
  // Ask the RPC which chain it is, rather than echoing the configured constant. A health
  // check that reports what it was told cannot detect being pointed at the wrong node.
  const chain = await client.getChainId().catch(() => null);
  res.json({
    role: config.role,
    chain,
    chainExpected: ARC_CHAIN_ID,
    chainMatches: chain === ARC_CHAIN_ID,
    head: head?.toString() ?? null,
    cursor: store.cursor(config.role)?.toString() ?? null,
    factory: config.factory ?? null,
    ...store.counts(),
  });
});

/** Paginated: the Monitoring table shows 100 a page and there are thousands of tokens. */
app.get('/tokens', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 200);
  const page = Math.max(Number(req.query.page ?? 1), 1);
  const total = store.tokenCount();
  res.json({
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    ...blockRate(),
    rows: store.top(limit, (page - 1) * limit).map((t) => ({
      ...t,
      explorer: `https://testnet.arcscan.app/address/${t.address}`,
    })),
  });
});

/**
 * Everything one wallet has going on: coins it launched, coins it holds, and what those
 * positions cost versus what they are worth.
 *
 * Computed here rather than in the browser because it needs a balance read per coin, and a
 * page that fans out N RPC calls per visitor is how this project earned its 429s.
 *
 * Cost basis is what the wallet actually paid on our curves — buys minus sells, from the
 * trade index. It cannot see tokens acquired anywhere else, so a position bought on the pool
 * after graduation shows a cost of zero rather than a wrong number.
 */
app.get('/portfolio', async (req, res) => {
  const addr = String(req.query.address ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return void res.status(400).json({ error: 'address required' });
  const who = addr.toLowerCase();

  const head = await client.getBlockNumber();
  const metrics = new Map(buildMetrics(store, head).map((m) => [m.token, m]));
  const launches = store.launchMeta();

  // net USDC into each coin from this wallet, from trades we indexed
  const cost = new Map<string, bigint>();
  for (const t of store.allTrades()) {
    if (t.trader.toLowerCase() !== who) continue;
    const v = BigInt(t.native_amt);
    cost.set(t.token, (cost.get(t.token) ?? 0n) + (t.side === 'buy' ? v : -v));
  }

  const tokenAbi = abiOf('HexaToken');
  const balances = await Promise.all(
    launches.map((l) =>
      client
        .readContract({ address: l.token as Address, abi: tokenAbi as never, functionName: 'balanceOf', args: [addr] } as never)
        .catch(() => 0n) as Promise<bigint>,
    ),
  );

  const holdings = launches
    .map((l, i) => ({ l, bal: balances[i] ?? 0n }))
    .filter((h) => h.bal > 0n)
    .map(({ l, bal }) => {
      const m = metrics.get(l.token);
      const tokens = Number(bal / 10n ** 18n);
      const price = m?.lastPrice ?? 0;
      const value = tokens * price;
      const invested = Number((cost.get(l.token) ?? 0n) / 10n ** 12n) / 1e6;
      return {
        token: l.token, curve: l.curve, symbol: l.symbol, name: l.name, phase: l.phase,
        image: imageOf(l.metadata_uri),
        balance: tokens, price, value,
        invested: Math.max(0, invested),
        pnl: invested > 0 ? value - invested : null,
        pnlPct: invested > 0 ? (value - invested) / invested : null,
      };
    })
    .sort((a, b) => b.value - a.value);

  const created = launches
    .filter((l) => (l.creator ?? '').toLowerCase() === who)
    .map((l) => ({
      token: l.token, curve: l.curve, symbol: l.symbol, name: l.name, phase: l.phase,
      image: imageOf(l.metadata_uri),
      revealBlock: l.reveal_block,
      mcap: metrics.get(l.token)?.mcap ?? null,
      vol24h: metrics.get(l.token)?.vol24h ?? null,
      txns: metrics.get(l.token)?.txns ?? 0,
    }))
    .sort((a, b) => (b.revealBlock ?? 0) - (a.revealBlock ?? 0));

  res.json({
    address: addr,
    created,
    holdings,
    totals: {
      positionValue: holdings.reduce((a, h) => a + h.value, 0),
      invested: holdings.reduce((a, h) => a + h.invested, 0),
    },
  });
});

/** Price, market cap, ATH and volume for the coins whose trades we index. */
/**
 * Per-token metrics, then corrected against each curve's live reserves.
 *
 * `buildMetrics` prices a trade at what the trader paid, which sits a fee above the curve's own
 * price and is not what the coin page shows. Reading the curve gives the exact figure, plus the
 * two things the cards need and trades alone cannot supply: how far along the bonding curve the
 * coin is, and how much USDC is actually in it.
 *
 * One read per coin, served from the same 5s cache as /curve, and failures fall back to the
 * trade-derived number rather than blanking the row.
 */
app.get('/metrics', async (_req, res) => {
  const head = await client.getBlockNumber();
  const rows = buildMetrics(store, head);

  await Promise.all(rows.slice(0, 60).map(async (r) => {
    if (!r.curve) return;
    try {
      const s = await readCurve(r.curve as Address, r.token as Address);
      const n = (v: string) => Number(BigInt(v)) / 1e18;
      const supply = n(s.totalSupply);
      const price = n(s.virtualUsdc) / n(s.virtualTokens);
      // The curve holds the unsold supply plus the LP reserve, so the reserve is the
      // difference — which is what turns "tokens left" into a percentage.
      const sellable = supply - (n(s.curveBal) - n(s.realTokens));

      // ATH from the same marginal path as the price, or it reports the fee-inclusive fill and
      // a coin that only ever went up shows an all-time high above its own market cap.
      const k = n(s.virtualUsdc) * n(s.virtualTokens);
      const rows = store.tradesOfToken(r.token);
      let vT = n(s.virtualTokens), athPrice = price;
      for (let i = rows.length - 1; i >= 0; i--) {
        vT += rows[i]!.side === 'buy' ? Number(rows[i]!.token_amt) / 1e18
                                      : -Number(rows[i]!.token_amt) / 1e18;
        athPrice = Math.max(athPrice, k / (vT * vT));
      }

      Object.assign(r, {
        lastPrice: price,
        mcap: price * supply,
        athPrice,
        ath: athPrice * supply,
        liquidityUsd: n(s.realUsdc),
        curvePct: sellable > 0 ? Math.min(100, ((sellable - n(s.realTokens)) / sellable) * 100) : 0,
        graduated: Boolean(s.graduated),
      });
    } catch { /* keep the trade-derived figures */ }
  }));

  res.json({ ...blockRate(), rows });
});

// The artwork URL is decoded here rather than in the browser: it is the one field every card
// needs, and every tab would otherwise base64-decode the same URIs itself.
app.get('/launches', (req, res) => res.json(
  store.listLaunches(Math.min(Number(req.query.limit ?? 50), 500))
    .map((r) => ({ ...r, image: imageOf(r.metadata_uri as string | null),
                    bundle: isBundle(r.metadata_uri as string | null) })),
));

/**
 * Everything the coin terminal draws, in one request: candles, the trade feed, holders and
 * windowed stats.
 *
 * One endpoint rather than four because the page refreshes on a timer and four round trips per
 * tick is three more chances to render a half-updated screen.
 *
 * Two honest limits. Trades carry a block number and not a timestamp, so times are derived
 * from the measured block rate and drift a little the further back you look. And holders are
 * reconstructed from curve trades, so a wallet that received tokens by plain transfer is not
 * counted — the alternative is indexing every Transfer of every coin, which is the job the
 * network role exists to avoid.
 */
app.get('/token', async (req, res) => {
  const token = String(req.query.token ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return void res.status(400).json({ error: 'token is required' });

  const meta = (store.listLaunches(500) as Record<string, unknown>[])
    .find((r) => String(r.token ?? '').toLowerCase() === token.toLowerCase());

  const head = Number(await client.getBlockNumber());
  const { blocksPerSecond } = blockRate();
  const rows = store.tradesOfToken(token);
  const at = (block: number) => Date.now() - ((head - block) / blocksPerSecond) * 1000;

  const trades = rows.map((t) => {
    const usdc = Number(t.native_amt) / 1e18;
    const tokens = Number(t.token_amt) / 1e18;
    return { tx: t.tx, trader: t.trader, side: t.side, usdc, tokens,
             // What the trader paid per token, fee included. Useful in the trade feed; wrong
             // for a chart, because it is an average over the fill and sits ~1% above the
             // curve's own price. `open`/`close` below use the marginal price instead.
             price: tokens > 0 ? usdc / tokens : 0,
             open: 0, close: 0,
             block: t.block, ts: at(t.block) };
  }).sort((a, b) => a.block - b.block || a.ts - b.ts);

  /**
   * The curve's marginal price before and after every trade.
   *
   * A bonding curve holds `virtualUsdc * virtualTokens` constant, so the price is
   * `k / virtualTokens²` and moves only when tokens leave or enter the curve. That makes the
   * whole price path recoverable from the token amounts alone: read the reserves once, undo
   * every trade to get the launch state, then replay forwards.
   *
   * Using each trade's average fill price instead — which is what this did — collapses every
   * candle to open == close, so a launch buy that moved the market cap from $2,000.00 to
   * $2,000.92 drew as a flat line, and the number disagreed with the header by the 1% fee.
   */
  let marginalOk = false;
  if (meta?.curve) {
    try {
      const s = await readCurve(String(meta.curve) as Address, token as Address);
      const vU = Number(BigInt(s.virtualUsdc)) / 1e18;
      const vT = Number(BigInt(s.virtualTokens)) / 1e18;
      const k = vU * vT;
      // Wind back to launch: buys took tokens out of the curve, sells put them back.
      let vTat = vT;
      for (let i = trades.length - 1; i >= 0; i--) {
        vTat += trades[i]!.side === 'buy' ? trades[i]!.tokens : -trades[i]!.tokens;
      }
      for (const t of trades) {
        t.open = k / (vTat * vTat);
        vTat += t.side === 'buy' ? -t.tokens : t.tokens;
        t.close = k / (vTat * vTat);
      }
      marginalOk = trades.every((t) => Number.isFinite(t.open) && t.open > 0 && t.close > 0);
    } catch { /* fall through to fill prices */ }
  }
  if (!marginalOk) for (const t of trades) { t.open = t.price; t.close = t.price; }

  /**
   * Candles.
   *
   * The selector is a candle *interval*, the way a charting app means it — not a filter that
   * hides history. Treating it as a filter meant a coin whose only trade was hours ago showed
   * an empty 5M chart, while every other launchpad still draws it.
   *
   * Empty intervals are carried forward at the previous close. On a bonding curve that is the
   * truth rather than a convenience: price is a pure function of reserves, so between trades
   * it genuinely does not move.
   */
  const w = parseWindow(req.query.window);
  const MAX_CANDLES = 400;
  const priced0 = trades.filter((t) => t.price > 0);
  // Integer, so bucket keys computed here and looked up below are the same numbers — and
  // floor, not round: rounding up by a fraction of a millisecond puts the very first trade in
  // bucket -1, which the fill loop never visits, and the whole series comes back empty.
  const firstTs = Math.floor(priced0[0]?.ts ?? Date.now());
  const lifeMs = Math.max(Date.now() - firstTs, 60_000);

  // An explicit interval wins: the chart's interval menu goes down to 1 second and up to 4
  // hours, which the stats window keys cannot express.
  const asked = Number(req.query.interval);
  const explicit = Number.isFinite(asked) && asked >= 1 && asked <= 604_800;
  let step = explicit ? Math.round(asked) * 1000 : (WINDOWS[w] || 0) * 1000;
  if (!step) step = lifeMs / 60;                                  // 'all' fits the whole life
  // Only widen the bucket when nobody asked for a specific one. A series labelled "1 second"
  // whose candles are silently 81 seconds wide is worse than a shorter history.
  if (!explicit && lifeMs / step > MAX_CANDLES) step = lifeMs / MAX_CANDLES;
  step = Math.max(1000, Math.round(step));

  // Too many buckets for the requested width: keep the width, show the most recent stretch.
  const startTs = lifeMs / step > MAX_CANDLES
    ? firstTs + Math.floor((lifeMs - MAX_CANDLES * step) / step) * step
    : firstTs;

  // A candle opens where the curve stood before its first trade and closes where it stood
  // after its last, so a single launch buy draws a real body instead of a hairline.
  type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
  const byBucket = new Map<number, Candle>();
  for (const t of priced0) {
    const bt = firstTs + Math.floor((t.ts - firstTs) / step) * step;
    const k = byBucket.get(bt);
    if (k) {
      k.h = Math.max(k.h, t.open, t.close); k.l = Math.min(k.l, t.open, t.close);
      k.c = t.close; k.v += t.usdc;
    } else {
      byBucket.set(bt, { t: bt, o: t.open, h: Math.max(t.open, t.close),
                         l: Math.min(t.open, t.close), c: t.close, v: t.usdc });
    }
  }

  // Only intervals that actually traded. Carrying the last close forward is defensible for a
  // curve — the price really does hold between trades — but it draws a run of identical empty
  // candles, and a coin with one trade should show one candle. The chart's own last-price line
  // already says where the price sits now.
  const candles: Candle[] = [...byBucket.values()]
    .filter((k) => k.t >= startTs)
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_CANDLES);

  // holders, net of buys and sells
  const held = new Map<string, { tokens: number; invested: number; sold: number }>();
  for (const t of trades) {
    const k = t.trader.toLowerCase();
    const h = held.get(k) ?? { tokens: 0, invested: 0, sold: 0 };
    if (t.side === 'buy') { h.tokens += t.tokens; h.invested += t.usdc; }
    else { h.tokens -= t.tokens; h.sold += t.usdc; }
    held.set(k, h);
  }
  const holders = [...held].filter(([, h]) => h.tokens > 1e-9)
    .map(([addr, h]) => ({ addr, tokens: h.tokens, invested: h.invested, realised: h.sold }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, 50);

  // Windowed stats. Here the same key really is a lookback period — "1h volume" means the
  // last hour — which is a different question from how wide a candle is.
  const statsFrom = WINDOWS[w] ? Date.now() - WINDOWS[w] * 1000 : 0;
  const inWin = trades.filter((t) => t.ts >= statsFrom);
  const buys = inWin.filter((t) => t.side === 'buy'), sells = inWin.filter((t) => t.side === 'sell');
  const sum = (xs: { usdc: number }[]) => xs.reduce((a, b) => a + b.usdc, 0);
  // Marginal prices again, so "price change" and ATH agree with the chart and the header
  // rather than sitting a fee above them.
  const priced = priced0;
  const lastPx = priced[priced.length - 1]?.close ?? 0;
  // Change is null, not zero, when nothing traded in the window. Falling back to the
  // first-ever price reports the all-time move under a "1h" label.
  const openPx = inWin.find((t) => t.open > 0)?.open ?? null;

  res.json({
    token, head, blocksPerSecond, window: w,
    meta: meta ? { symbol: meta.symbol, name: meta.name, creator: meta.creator,
                   curve: meta.curve, phase: meta.phase, revealBlock: meta.reveal_block,
                   revealedAt: meta.reveal_block ? at(Number(meta.reveal_block)) : null,
                   // Decoded here rather than in the browser: the URI is a base64 data URI the
                   // creator supplied, so it is parsed once by us instead of by every tab.
                   ...decodeMetadata(String(meta.metadata_uri ?? '')) } : null,
    candles,
    trades: trades.slice(-60).reverse(),
    holders,
    stats: {
      price: lastPx,
      change: openPx && openPx > 0 ? (lastPx - openPx) / openPx : null,
      ath: priced.reduce((m, t) => Math.max(m, t.open, t.close), 0),
      volume: sum(inWin), buyVol: sum(buys), sellVol: sum(sells),
      buys: buys.length, sells: sells.length,
      buyers: new Set(buys.map((t) => t.trader.toLowerCase())).size,
      sellers: new Set(sells.map((t) => t.trader.toLowerCase())).size,
      holders: holders.length, txns: trades.length,
    },
  });
});

/**
 * Live curve state for a coin page.
 *
 * The browser must not read this from the RPC directly. Arc's public endpoint rate-limits by
 * IP, and a coin page needs a dozen values on a timer — so every open tab multiplies the
 * load until the endpoint answers 429 and the page shows nothing. One server polling with a
 * short cache serves any number of tabs from the same budget.
 */
const curveCache = new Map<string, { at: number; data: unknown }>();
const CURVE_TTL = 5_000;

type CurveState = {
  symbol: unknown; name: unknown; graduated: unknown; inGuardWindow: unknown;
  totalSupply: string; curveBal: string; virtualUsdc: string; virtualTokens: string;
  realTokens: string; realUsdc: string; sellTaxBps: number; creatorHeld: string;
};

/** Shared by /curve and /token, so the terminal's two reads cost one RPC round trip. */
async function readCurve(curve: Address, token: Address): Promise<CurveState> {
  const key = `${curve}|${token}`;
  const hit = curveCache.get(key);
  if (hit && Date.now() - hit.at < CURVE_TTL) return hit.data as CurveState;

  const curveAbi = abiOf('HexaCurve');
  const tokenAbi = abiOf('HexaToken');
  const call = (address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi: abi as never, functionName, args } as never);

  try {
    const [symbol, name, totalSupply, curveBal, virtualUsdc, virtualTokens, realTokens, realUsdc, graduated, sellTaxBps, inGuardWindow, creatorHeld] =
      await Promise.all([
        call(token, tokenAbi, 'symbol'), call(token, tokenAbi, 'name'),
        call(token, tokenAbi, 'totalSupply'), call(token, tokenAbi, 'balanceOf', [curve]),
        call(curve, curveAbi, 'virtualUsdc'), call(curve, curveAbi, 'virtualTokens'),
        call(curve, curveAbi, 'realTokens'), call(curve, curveAbi, 'realUsdc'),
        call(curve, curveAbi, 'graduated'), call(curve, curveAbi, 'sellTaxBps'),
        call(curve, curveAbi, 'inGuardWindow'), call(curve, curveAbi, 'creatorHeld'),
      ]);
    const data: CurveState = {
      symbol, name, graduated, inGuardWindow,
      totalSupply: String(totalSupply), curveBal: String(curveBal),
      virtualUsdc: String(virtualUsdc), virtualTokens: String(virtualTokens),
      realTokens: String(realTokens), realUsdc: String(realUsdc),
      sellTaxBps: Number(sellTaxBps), creatorHeld: String(creatorHeld),
    };
    curveCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    // Serve stale rather than nothing: a rate-limited refresh should not blank a working page.
    if (hit) return hit.data as CurveState;
    throw e;
  }
}

app.get('/curve', async (req, res) => {
  const curve = String(req.query.address ?? '') as Address;
  const token = String(req.query.token ?? '') as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(curve) || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return void res.status(400).json({ error: 'address and token are required' });
  }
  try {
    res.json(await readCurve(curve, token));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message.slice(0, 160) });
  }
});

/**
 * Coin artwork.
 *
 * Images cannot go on-chain — a 500×500 PNG is orders of magnitude past what calldata can
 * carry, and a 5 MB video is not close. They have to live on a server, and the indexer is
 * already the server this project runs, so it stores them rather than adding a dependency
 * on a pinning service nobody has signed up for.
 *
 * The honest limitation: these files live and die with this machine. Artwork that outlives
 * the operator needs IPFS or equivalent, which is a decision about who pays for pinning.
 */
const MEDIA_DIR = join(config.stateDir, 'media');
// Two caps, matching what a launchpad this size is expected to accept. The raw-body limit has
// to be the larger of them, so the per-type check below is what actually enforces the image
// cap — without it a 30 MB PNG would sail through.
const MEDIA_MAX_IMAGE = 15 * 1024 * 1024;
const MEDIA_MAX_VIDEO = 30 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4',
};

mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));

app.post('/upload', express.raw({ type: () => true, limit: MEDIA_MAX_VIDEO }), (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
  const ext = MEDIA_TYPES[type];
  if (!ext) return void res.status(415).json({ error: `unsupported type ${type || '(none)'}` });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: 'empty body' });
  const cap = type.startsWith('video/') ? MEDIA_MAX_VIDEO : MEDIA_MAX_IMAGE;
  if (body.length > cap) {
    return void res.status(413).json({ error: `over ${cap / 1024 / 1024} MB` });
  }

  // Content-addressed: the same artwork uploaded twice is stored once, and a coin's image
  // URL cannot be repointed at different bytes later.
  const name = `${createHash('sha256').update(body).digest('hex').slice(0, 40)}.${ext}`;
  writeFileSync(join(MEDIA_DIR, name), body);
  res.json({ url: `/media/${name}`, bytes: body.length, type });
});

/* ── asset packs ────────────────────────────────────────────────────────────
 * Mode 2 launches. `docs/PACKS.md` has the design; `packs.ts` has the storage rules.
 *
 * Uploads are unauthenticated on purpose, the same way `/upload` is: a manifest only means
 * anything once a coin's on-chain metadata commits to its hash, so an unreferenced one is
 * orphaned bytes rather than a claim about any coin. The size caps are what bound the disk.
 */
const packs = packStore(config.stateDir);

// The parser's ceiling sits above the real cap on purpose. Set equal, express.raw rejects first
// with a bare 413 and no body, and the readable "over 10 MB" below could never fire — the same
// reason /upload gives the raw parser the video limit and checks images separately.
app.post('/packs/asset', express.raw({ type: () => true, limit: LIMITS.bytesPerAsset + 1048576 }), (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
  try {
    res.json(packs.putAsset(req.body as Buffer, type));
  } catch (e) {
    res.status(type && !PACK_TYPES[type] ? 415 : 400).json({ error: (e as Error).message });
  }
});

app.post('/packs/manifest', express.json({ limit: '256kb' }), (req, res) => {
  try {
    res.json(packs.putManifest(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Which manifest a coin committed to, from its on-chain metadata — never from a lookup table. */
function packsOf(token: string) {
  const row = store.launchMeta().find((l) => l.token?.toLowerCase() === token.toLowerCase());
  if (!row) return null;
  const hash = decodeMetadata(String(row.metadata_uri ?? '')).packs;
  return hash ? { hash, row } : null;
}

/**
 * What a pack is, without any of its bytes. Everything here is public: the point of a preview is
 * to be seen before anyone holds the coin.
 */
app.get('/packs/:token', (req, res) => {
  const found = packsOf(String(req.params.token));
  if (!found) return void res.json({ packs: [] });
  const removed = packs.removal(found.hash);
  const m = packs.readManifest(found.hash);
  if (!m) {
    // The coin committed to a hash this node has never seen. Say so rather than reporting no
    // packs — "we do not have it" and "there are none" are different answers.
    return void res.json({ manifest: found.hash, missing: true, packs: [] });
  }
  res.json({
    manifest: found.hash,
    removed,
    packs: m.packs.map((p, i) => ({
      index: i, name: p.name, description: p.description, gate: p.gate,
      assets: p.assets.length,
      // Resolved here rather than in the page: whether a preview was generated or uploaded is a
      // storage detail, and the client only ever needs somewhere to point an <img> at.
      previewUrl: p.preview.kind === 'creator' ? p.preview.url
                                              : `/packs/${found.hash}/preview/${i}`,
    })),
  });
});

/** Generated on first request and cached to disk — immutable, because the hash names the bytes. */
app.get('/packs/:hash/preview/:index', async (req, res) => {
  try {
    const png = await packs.preview(String(req.params.hash), Number(req.params.index));
    if (!png) return void res.status(404).json({ error: 'no such pack' });
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Download one pack.
 *
 * The gate is checked against the chain's own `balanceOf`, not against holdings reconstructed
 * from indexed trades: a wallet that received the coin as a plain transfer never appears in the
 * trade history and would be told it does not hold what it is holding.
 *
 * A signature is proof of address, and it carries a timestamp so an intercepted one stops working
 * shortly after. It is deliberately not hardened further — once a holder has the zip, the zip is
 * out, which is the intended outcome for a pack whose job is to spread.
 */
const DOWNLOAD_WINDOW_MS = 5 * 60 * 1000;
export const downloadMessage = (token: string, index: number, ts: number) =>
  `Hexapus pack download\ntoken: ${token.toLowerCase()}\npack: ${index}\nat: ${ts}`;

app.post('/packs/:token/download', express.json({ limit: '8kb' }), async (req, res) => {
  const token = String(req.params.token);
  const { index, address, signature, ts } = (req.body ?? {}) as
    { index?: number; address?: string; signature?: string; ts?: number };

  const found = packsOf(token);
  if (!found) return void res.status(404).json({ error: 'no packs for this coin' });
  const removed = packs.removal(found.hash);
  if (removed) return void res.status(451).json({ error: removed });

  const m = packs.readManifest(found.hash);
  const pack = typeof index === 'number' ? m?.packs[index] : undefined;
  if (!pack) return void res.status(404).json({ error: 'no such pack' });

  if (pack.gate !== 'public') {
    if (!address || !signature || typeof ts !== 'number') {
      return void res.status(401).json({ error: 'signature required' });
    }
    if (Math.abs(Date.now() - ts) > DOWNLOAD_WINDOW_MS) {
      return void res.status(401).json({ error: 'signature expired, try again' });
    }
    let signer: string;
    try {
      signer = await recoverMessageAddress({
        message: downloadMessage(token, index!, ts), signature: signature as `0x${string}`,
      });
    } catch {
      return void res.status(401).json({ error: 'bad signature' });
    }
    if (signer.toLowerCase() !== address.toLowerCase()) {
      return void res.status(401).json({ error: 'signature does not match the address' });
    }

    if (pack.gate === 'graduated') {
      if (String(found.row.phase) !== 'GRADUATED') {
        return void res.status(403).json({ error: 'unlocks when the coin graduates' });
      }
    } else {
      const held = await client.readContract({
        address: token as Address, abi: abiOf('HexaToken') as never,
        functionName: 'balanceOf', args: [getAddress(address)],
      } as never) as bigint;
      if (held <= 0n) return void res.status(403).json({ error: 'hold the coin to unlock this pack' });
    }
  }

  const zip = packs.zip(found.hash, index!);
  if (!zip) return void res.status(404).json({ error: 'no such pack' });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition',
    `attachment; filename="${String(found.row.symbol ?? 'pack')}-${index! + 1}.zip"`);
  res.send(zip);
});

const parseWindow = (q: unknown): WindowKey =>
  typeof q === 'string' && q in WINDOWS ? (q as WindowKey) : '1h';

/** Explore -> Trending: turnover, fresh wallets and price velocity, z-scored per window. */
app.get('/trending', async (req, res) => {
  const w = parseWindow(req.query.window);
  const head = await client.getBlockNumber();
  const scored = scoreTrending(buildWindows(store, w, head));
  // Report what was filtered out and why. An unexplained empty list is indistinguishable
  // from a broken feed, and on a young chain the gates exclude almost everything.
  const excluded = scored
    .filter((r) => r.gated)
    .map((r) => ({ token: r.token, symbol: r.symbol, reason: r.gated, liquidityUsd: r.liquidityUsd, trades: r.trades }));
  res.json({
    window: w,
    ...blockRate(),
    thresholds: { minLiquidityUsd: RULES.MIN_LIQUIDITY_USD, minTrades: RULES.MIN_TRADES },
    excluded,
    rows: decorate(store, scored.filter((r) => !r.gated)).slice(0, 60),
  });
});

/** Explore -> Movers: deliberately the dumb one, raw traded volume only. */
app.get('/movers', async (req, res) => {
  const w = parseWindow(req.query.window);
  const head = await client.getBlockNumber();
  res.json({ window: w, ...blockRate(), rows: decorate(store, scoreMovers(buildWindows(store, w, head))).slice(0, 60) });
});

/** Explore -> Booster: buys made by someone who arrived through a referral link. */
app.get('/booster', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  res.json(
    store.booster(limit).map((r) => ({
      token: r.token,
      curve: r.curve ?? null,
      symbol: r.symbol ?? null,
      name: r.name ?? null,
      referrer: r.referrer,
      buyer: r.buyer,
      usdc: Number(BigInt(r.native_amt as string) / 10n ** 12n) / 1e6,
      block: r.block,
      tx: r.tx,
    })),
  );
});

// Never let the process disappear without saying why. A silent exit is the one failure mode
// that cannot be debugged after the fact.
process.on('unhandledRejection', (r) => log('UNHANDLED REJECTION:', r instanceof Error ? r.stack : String(r)));
process.on('uncaughtException', (e) => log('UNCAUGHT EXCEPTION:', e.stack ?? e.message));
process.on('exit', (code) => log(`process exiting with code ${code}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log(`received ${sig}, shutting down`); process.exit(0); });
}

const server = app.listen(config.port, () => {
  log(`hexapus indexer role=${config.role} port=${config.port} state=${config.stateDir}`);
  if (config.factory) log(`watching factory ${config.factory}`);
  if (factoryMismatch) {
    log('WARNING: HEXA_FACTORY_ADDRESS does not match the latest deployment.');
    log(`  .env      ${factoryMismatch.env}`);
    log(`  deployed  ${factoryMismatch.deployed}`);
    log('  Following .env. Clear that line to follow the deployment, and use a fresh');
    log('  HEXA_STATE_DIR when you switch — the old database describes the old factory.');
  }

  // Time windows are stored as block ranges, so the conversion has to come from the chain.
  const refreshRate = () =>
    measureBlockRate()
      .then((bps) => log(`block rate ${bps.toFixed(3)}/s  (1h = ${Math.ceil(bps * 3600)} blocks)`))
      .catch((e) => log('block rate measurement failed:', (e as Error).message.slice(0, 100)));
  refreshRate();
  setInterval(refreshRate, 10 * 60_000);

  (config.role === 'hexa' ? runHexa() : runNetwork()).catch((e) => {
    log('fatal:', (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  });
});
server.on('error', (e) => { log('http server error:', e.message); process.exit(1); });
