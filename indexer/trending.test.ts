import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrending, scoreMovers, capWalletVolume, type TokenWindow } from './trending.js';

const mk = (o: Partial<TokenWindow> & { symbol: string }): TokenWindow => ({
  token: '0x' + o.symbol,
  volumeUsd: 0,
  topWalletShare: 0.2,
  newWallets: 0,
  priceStart: 1,
  priceEnd: 1,
  liquidityUsd: 10_000,
  trades: 50,
  ...o,
});

// The cohort every test scores against.
const cohort = (): TokenWindow[] => [
  // Small coin, lots of genuine churn and fresh wallets. Should win Trending.
  mk({ symbol: 'ORGANIC', volumeUsd: 8_000, liquidityUsd: 2_000, newWallets: 120, priceStart: 1, priceEnd: 1.8, trades: 340, topWalletShare: 0.12 }),
  // Huge raw volume but flat, mature, few new wallets. Should win Movers, not Trending.
  mk({ symbol: 'WHALE', volumeUsd: 50_000, liquidityUsd: 400_000, newWallets: 6, priceStart: 1, priceEnd: 1.01, trades: 210, topWalletShare: 0.3 }),
  // One wallet doing almost all the volume. Wash trading.
  mk({ symbol: 'WASH', volumeUsd: 30_000, liquidityUsd: 3_000, newWallets: 3, priceStart: 1, priceEnd: 1.6, trades: 400, topWalletShare: 0.97 }),
  // $80 of liquidity printing +9000%.
  mk({ symbol: 'DUST', volumeUsd: 900, liquidityUsd: 80, newWallets: 40, priceStart: 0.001, priceEnd: 0.091, trades: 60 }),
  // Two wallets ping-ponging.
  mk({ symbol: 'PINGPONG', volumeUsd: 12_000, liquidityUsd: 5_000, newWallets: 2, priceStart: 1, priceEnd: 2.4, trades: 3 }),
  mk({ symbol: 'STEADY', volumeUsd: 4_000, liquidityUsd: 20_000, newWallets: 25, priceStart: 1, priceEnd: 1.05, trades: 90 }),
];

const bySymbol = (rows: { symbol: string }[]) => rows.map((r) => r.symbol);

test('organic churn outranks raw volume', () => {
  const ranked = scoreTrending(cohort());
  assert.equal(ranked[0]!.symbol, 'ORGANIC');
  const whale = ranked.findIndex((r) => r.symbol === 'WHALE');
  const organic = ranked.findIndex((r) => r.symbol === 'ORGANIC');
  assert.ok(organic < whale, 'ORGANIC must outrank WHALE on Trending');
});

test('Trending is not just Movers with extra steps', () => {
  const t = bySymbol(scoreTrending(cohort()));
  const m = bySymbol(scoreMovers(cohort()));
  assert.notDeepEqual(t, m);
  assert.equal(m[0], 'WHALE', 'Movers ranks raw volume, so the whale leads there');
  assert.notEqual(t[0], 'WHALE', 'Trending must not be led by raw volume');
});

test('thin liquidity is gated, however big the percentage move', () => {
  const dust = scoreTrending(cohort()).find((r) => r.symbol === 'DUST')!;
  assert.equal(dust.gated, 'thin-liquidity');
  assert.equal(dust.score, 0);
});

test('a handful of trades is gated', () => {
  const pp = scoreTrending(cohort()).find((r) => r.symbol === 'PINGPONG')!;
  assert.equal(pp.gated, 'too-few-trades');
  assert.equal(pp.score, 0);
});

test('wash trading is discounted toward zero', () => {
  const wash = scoreTrending(cohort()).find((r) => r.symbol === 'WASH')!;
  assert.ok(wash.washPenalty < 0.1, `expected heavy penalty, got ${wash.washPenalty}`);
  // Same coin, same volume, but spread across many wallets: must score strictly higher.
  const honest = cohort().map((t) => (t.symbol === 'WASH' ? { ...t, topWalletShare: 0.15 } : t));
  const washed = scoreTrending(cohort()).find((r) => r.symbol === 'WASH')!.score;
  const spread = scoreTrending(honest).find((r) => r.symbol === 'WASH')!.score;
  assert.ok(spread > washed, 'spreading the same volume across wallets must score higher');
});

test('a uniform cohort produces no signal rather than infinite signal', () => {
  const flat = ['A', 'B', 'C'].map((symbol) =>
    mk({ symbol, volumeUsd: 1_000, liquidityUsd: 10_000, newWallets: 10, trades: 40 }),
  );
  for (const r of scoreTrending(flat)) assert.equal(r.score, 0);
});

test('per-wallet capping blunts a single buyer', () => {
  // Nine small wallets and one buying 100x more than anyone else.
  const wallets = [50, 60, 55, 70, 45, 65, 52, 58, 61, 6_000];
  const { volumeUsd, topWalletShare } = capWalletVolume(wallets);
  const raw = wallets.reduce((a, b) => a + b, 0);
  assert.ok(topWalletShare > 0.9, 'detects the concentration');
  assert.ok(volumeUsd < raw * 0.2, `capped ${volumeUsd} should be far below raw ${raw}`);
});
