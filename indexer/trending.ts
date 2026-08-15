/**
 * Trending score — momentum from three signals: turnover, new wallets, price velocity.
 *
 * The design problem is that "most volume" is already the Movers tab. If Trending also
 * ranked on raw volume it would be the same list with a different name. So Trending ranks
 * on **turnover** (volume relative to liquidity), which is scale-free: a $2k coin doing
 * $8k of volume outranks a $400k coin doing $50k, because proportionally more is happening.
 *
 * Scores are z-scored against the cohort in the same window, so "trending" means
 * unusual *right now* rather than unusual against some constant nobody retunes.
 */

export type TokenWindow = {
  token: string;
  symbol: string;
  /** USD volume, with each wallet's contribution already capped (see capWalletVolume). */
  volumeUsd: number;
  /** Largest single wallet's share of raw volume, 0..1. Wash-trading detector. */
  topWalletShare: number;
  /** Wallets whose first-ever trade of THIS token landed in the window, above MIN_TRADE_USD. */
  newWallets: number;
  priceStart: number;
  priceEnd: number;
  /** Curve realUsdc pre-graduation, pool reserves after. */
  liquidityUsd: number;
  trades: number;
};

export const RULES = {
  /**
   * Below this, percentage moves are noise — a $50 pool can print +9000% on one buy.
   *
   * Configurable because the right floor is a property of the market, not of the algorithm:
   * $500 is sensible on a live chain and excludes everything on a testnet where coins are
   * worth $30. Set MIN_LIQUIDITY_USD=1 to see testnet coins ranked.
   */
  MIN_LIQUIDITY_USD: Number(process.env.MIN_LIQUIDITY_USD ?? 500),
  /** Two wallets ping-ponging is not a trend. */
  MIN_TRADES: Number(process.env.MIN_TRADES ?? 5),
  /** A wallet must move at least this much to count as a "new wallet". Sybil costs money. */
  MIN_TRADE_USD: 10,
  /** Price velocity is capped: a 40x does not deserve 40x the score of a 1x. */
  PRICE_CLAMP: [-0.5, 3] as [number, number],
  /** Above this share for one wallet, the volume signal starts getting discounted. */
  WASH_THRESHOLD: 0.5,
  WEIGHTS: { turnover: 0.45, newWallets: 0.35, priceVelocity: 0.2 },
};

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function zscore(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  // Everything identical => no signal, not infinite signal.
  return sd === 0 ? values.map(() => 0) : values.map((v) => (v - mean) / sd);
}

export type Scored = TokenWindow & {
  score: number;
  turnover: number;
  priceVelocity: number;
  washPenalty: number;
  gated: string | null;
};

export function scoreTrending(cohort: TokenWindow[]): Scored[] {
  const gate = (t: TokenWindow): string | null =>
    t.liquidityUsd < RULES.MIN_LIQUIDITY_USD ? 'thin-liquidity'
    : t.trades < RULES.MIN_TRADES ? 'too-few-trades'
    : null;

  const derived = cohort.map((t) => {
    const turnover = t.volumeUsd / Math.max(t.liquidityUsd, RULES.MIN_LIQUIDITY_USD);
    const priceVelocity = t.priceStart > 0
      ? clamp((t.priceEnd - t.priceStart) / t.priceStart, ...RULES.PRICE_CLAMP)
      : 0;
    // One wallet owning most of the volume is wash-trading, not interest. Discount linearly
    // past the threshold rather than banning it — honest coins can have one whale too.
    const excess = Math.max(0, t.topWalletShare - RULES.WASH_THRESHOLD);
    const washPenalty = 1 - excess / (1 - RULES.WASH_THRESHOLD);
    return { t, turnover, priceVelocity, washPenalty, gated: gate(t) };
  });

  // Log-compress before z-scoring: these are heavy-tailed, and one outlier would otherwise
  // flatten the whole cohort into its shadow.
  const live = derived.filter((d) => !d.gated);
  const zv = zscore(live.map((d) => Math.log1p(d.turnover)));
  const zn = zscore(live.map((d) => Math.log1p(d.t.newWallets)));
  const zp = zscore(live.map((d) => Math.max(0, d.priceVelocity)));
  const { turnover: wv, newWallets: wn, priceVelocity: wp } = RULES.WEIGHTS;

  const scoreOf = new Map<string, number>();
  live.forEach((d, i) => {
    const raw = wv * zv[i]! + wn * zn[i]! + wp * zp[i]!;
    scoreOf.set(d.t.token, raw * d.washPenalty);
  });

  return derived
    .map((d) => ({
      ...d.t,
      turnover: d.turnover,
      priceVelocity: d.priceVelocity,
      washPenalty: d.washPenalty,
      gated: d.gated,
      score: d.gated ? 0 : (scoreOf.get(d.t.token) ?? 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Movers is deliberately the dumb one: raw traded volume, nothing else. */
export function scoreMovers(cohort: TokenWindow[]): TokenWindow[] {
  return [...cohort].sort((a, b) => b.volumeUsd - a.volumeUsd);
}

/**
 * Cap one wallet's contribution to a token's volume at the cohort's 90th percentile wallet,
 * so a single actor cannot buy its way onto the board. Apply when aggregating trades.
 */
export function capWalletVolume(perWallet: number[]): { volumeUsd: number; topWalletShare: number } {
  if (perWallet.length === 0) return { volumeUsd: 0, topWalletShare: 0 };
  const sorted = [...perWallet].sort((a, b) => a - b);
  // ceil(0.9n) - 1, not floor(0.9n): with n = 10 the latter indexes the maximum itself, so
  // the "cap" equals the whale and clips nothing. Off-by-one that silently disables the cap.
  const idx = clamp(Math.ceil(sorted.length * 0.9) - 1, 0, sorted.length - 1);
  const p90 = sorted[idx]!;
  const raw = perWallet.reduce((a, b) => a + b, 0);
  const capped = perWallet.reduce((a, b) => a + Math.min(b, p90), 0);
  return { volumeUsd: capped, topWalletShare: raw === 0 ? 0 : Math.max(...perWallet) / raw };
}
