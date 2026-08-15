import { client } from './config.js';
import type { Store, TradeRow } from './store.js';
import { capWalletVolume, type TokenWindow } from './trending.js';

/**
 * Turns raw trades into the per-token windows the Trending and Movers tabs rank on.
 *
 * The awkward part is that trades are stored by block number while the tabs filter by time.
 * Arc's block rate is not a constant anyone should hardcode, so it is measured from the
 * chain and refreshed periodically — two RPC calls, not a guess.
 */

const E18 = 10n ** 18n;

let blocksPerSecond = 2; // seeded from observation; replaced by the first real measurement
let measuredAt = 0;

/** Sample two blocks an hour or so apart and derive the real rate. */
export async function measureBlockRate(): Promise<number> {
  const head = await client.getBlockNumber();
  const span = head > 5_000n ? 5_000n : head;
  if (span < 10n) return blocksPerSecond;

  const [a, b] = await Promise.all([
    client.getBlock({ blockNumber: head - span }),
    client.getBlock({ blockNumber: head }),
  ]);
  const seconds = Number(b.timestamp - a.timestamp);
  // Arc timestamps are non-decreasing rather than strictly increasing, so a short or idle
  // span can report zero elapsed time. Keep the previous estimate rather than dividing by it.
  if (seconds > 0) {
    blocksPerSecond = Number(span) / seconds;
    measuredAt = Date.now();
  }
  return blocksPerSecond;
}

export const blockRate = () => ({ blocksPerSecond, measuredAt });

export const WINDOWS = { '5m': 300, '1h': 3_600, '6h': 21_600, '24h': 86_400, all: 0 } as const;
export type WindowKey = keyof typeof WINDOWS;

/** How many blocks back a window reaches. `all` reaches to the beginning. */
export function windowBlocks(w: WindowKey): number {
  const seconds = WINDOWS[w] ?? 3_600;
  return seconds === 0 ? 0 : Math.ceil(seconds * blocksPerSecond);
}

/**
 * Price of one whole token in USDC, from a single trade. Both legs are 18-decimal, so the
 * ratio is already the price — no decimal juggling.
 */
const tradePrice = (t: TradeRow) => {
  const tokens = BigInt(t.token_amt);
  if (tokens === 0n) return 0;
  return Number((BigInt(t.native_amt) * E18) / tokens) / 1e18;
};

export function buildWindows(store: Store, w: WindowKey, head: bigint): TokenWindow[] {
  const back = windowBlocks(w);
  const from = back === 0 ? 0 : Math.max(0, Number(head) - back);
  const inWindow = back === 0 ? store.allTrades() : store.tradesSince(from);
  if (inWindow.length === 0) return [];

  // Liquidity is the curve's net intake over all time, not just this window — a token's
  // depth does not reset because the clock did.
  const netByToken = new Map<string, bigint>();
  for (const t of store.allTrades()) {
    const v = BigInt(t.native_amt);
    netByToken.set(t.token, (netByToken.get(t.token) ?? 0n) + (t.side === 'buy' ? v : -v));
  }

  // A wallet counts as new to a token only if its first-ever trade there is inside the
  // window. Anything looser would count returning holders as fresh interest.
  const firstTouch = new Map<string, number>();
  for (const r of store.firstTouch()) firstTouch.set(`${r.token}|${r.trader.toLowerCase()}`, r.first_block);

  const meta = new Map(store.launchMeta().map((m) => [m.token, m]));

  type Acc = { perWallet: Map<string, bigint>; trades: TradeRow[] };
  const byToken = new Map<string, Acc>();
  for (const t of inWindow) {
    let acc = byToken.get(t.token);
    if (!acc) byToken.set(t.token, (acc = { perWallet: new Map(), trades: [] }));
    acc.trades.push(t);
    const k = t.trader.toLowerCase();
    acc.perWallet.set(k, (acc.perWallet.get(k) ?? 0n) + BigInt(t.native_amt));
  }

  const out: TokenWindow[] = [];
  for (const [token, acc] of byToken) {
    const perWallet = [...acc.perWallet.values()].map((v) => Number(v / 10n ** 12n) / 1e6);
    const { volumeUsd, topWalletShare } = capWalletVolume(perWallet);

    let newWallets = 0;
    for (const trader of acc.perWallet.keys()) {
      const first = firstTouch.get(`${token}|${trader}`);
      // Trades under $10 do not buy a wallet a place in the count; sybils should cost money.
      if (first !== undefined && first >= from && (acc.perWallet.get(trader) ?? 0n) >= 10n * E18) newWallets++;
    }

    const m = meta.get(token);
    out.push({
      token,
      symbol: m?.symbol ?? token.slice(0, 8),
      volumeUsd,
      topWalletShare,
      newWallets,
      priceStart: tradePrice(acc.trades[0]!),
      priceEnd: tradePrice(acc.trades[acc.trades.length - 1]!),
      liquidityUsd: Math.max(0, Number((netByToken.get(token) ?? 0n) / 10n ** 12n) / 1e6),
      trades: acc.trades.length,
    });
  }
  return out;
}

/**
 * Coin metadata, as written by the creator into a base64 data URI at reveal.
 *
 * Every field here is attacker-controlled — the creator chooses the strings — so links are
 * only surfaced when they parse as http(s) URLs. A `javascript:` "website" rendered into an
 * anchor would be a stored XSS on the coin page.
 *
 * It lives here rather than beside the routes because every list endpoint needs the artwork
 * URL out of it, and the routes are not the only caller any more.
 */
export function decodeMetadata(uri: string) {
  const PREFIX = 'data:application/json;base64,';
  if (!uri.startsWith(PREFIX)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(uri.slice(PREFIX.length), 'base64').toString('utf8'));
  } catch { return {}; }
  const link = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 400) return undefined;
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
    } catch { return undefined; }
  };
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 500 ? v : undefined);
  return {
    description: text(parsed.description),
    image: link(parsed.image),
    website: link(parsed.website),
    x: link(parsed.x),
    telegram: link(parsed.telegram),
  };
}

/** The artwork URL alone, which is all a list row needs. */
export const imageOf = (uri: string | null | undefined) => decodeMetadata(uri ?? '').image ?? null;

export type Metrics = {
  token: string; symbol: string | null; name: string | null; curve: string | null; phase: string;
  image: string | null;
  lastPrice: number; athPrice: number; mcap: number; ath: number;
  vol24h: number; traders24h: number; txns: number;
  change1h: number | null; change6h: number | null; change24h: number | null;
  firstBlock: number;
  // Filled in by /metrics from the curve's live reserves; absent if that read failed.
  liquidityUsd?: number; curvePct?: number; graduated?: boolean;
};

/**
 * Per-token metrics for the Monitoring table, computed from the trades we have indexed.
 *
 * Only coins launched through Hexapus appear here, because these numbers come from curve
 * trade events. Tokens found by the full-chain scan have no price history we can honestly
 * quote, and the table shows them with blanks rather than invented figures.
 */
export function buildMetrics(store: Store, head: bigint): Metrics[] {
  const trades = store.allTrades();
  if (!trades.length) return [];

  const meta = new Map(store.launchMeta().map((m) => [m.token, m]));
  const supplies = new Map<string, number>();
  for (const t of store.top(1000)) if (t.total_supply && t.decimals != null) {
    supplies.set(t.address, Number(BigInt(t.total_supply) / 10n ** BigInt(t.decimals)));
  }

  const cut = (secs: number) => Number(head) - Math.ceil(secs * blocksPerSecond);
  const b1h = cut(3_600), b6h = cut(21_600), b24h = cut(86_400);

  type Acc = {
    prices: { block: number; price: number }[];
    vol24h: number; traders24h: Set<string>; txns: number;
  };
  const acc = new Map<string, Acc>();

  for (const t of trades) {
    let a = acc.get(t.token);
    if (!a) acc.set(t.token, (a = { prices: [], vol24h: 0, traders24h: new Set(), txns: 0 }));
    a.txns++;
    const p = tradePrice(t);
    if (p > 0) a.prices.push({ block: t.block, price: p });
    if (t.block >= b24h) {
      a.vol24h += Number(BigInt(t.native_amt) / 10n ** 12n) / 1e6;
      a.traders24h.add(t.trader.toLowerCase());
    }
  }

  // Price as of a cutoff = the last trade at or before it. Null when the coin did not exist
  // that far back, which is different from "no change" and is rendered differently.
  const priceAt = (a: Acc, block: number) => {
    let found: number | null = null;
    for (const p of a.prices) { if (p.block <= block) found = p.price; else break; }
    return found;
  };
  const change = (last: number, before: number | null) =>
    before === null || before === 0 ? null : (last - before) / before;

  const out: Metrics[] = [];
  for (const [token, a] of acc) {
    if (!a.prices.length) continue;
    const last = a.prices[a.prices.length - 1]!.price;
    const ath = Math.max(...a.prices.map((p) => p.price));
    const supply = supplies.get(token) ?? 1_000_000_000;
    const m = meta.get(token);
    out.push({
      token, symbol: m?.symbol ?? null, name: m?.name ?? null, curve: m?.curve ?? null,
      phase: m?.phase ?? 'UNKNOWN', image: imageOf(m?.metadata_uri),
      lastPrice: last, athPrice: ath, mcap: last * supply, ath: ath * supply,
      vol24h: a.vol24h, traders24h: a.traders24h.size, txns: a.txns,
      change1h: change(last, priceAt(a, b1h)),
      change6h: change(last, priceAt(a, b6h)),
      change24h: change(last, priceAt(a, b24h)),
      firstBlock: a.prices[0]!.block,
    });
  }
  return out.sort((x, y) => y.mcap - x.mcap);
}

/** Extra fields the UI wants that the scoring model has no opinion about. */
export function decorate(store: Store, rows: { token: string }[]) {
  const meta = new Map(store.launchMeta().map((m) => [m.token, m]));
  return rows.map((r) => {
    const m = meta.get(r.token);
    return {
      ...r,
      name: m?.name ?? null,
      curve: m?.curve ?? null,
      phase: m?.phase ?? 'UNKNOWN',
      creator: m?.creator ?? null,
      image: imageOf(m?.metadata_uri),
      revealBlock: m?.reveal_block ?? null,
      explorer: `https://testnet.arcscan.app/address/${r.token}`,
    };
  });
}
