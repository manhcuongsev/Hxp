// Replays HexaCurve's exact integer math to check the parameter claims in docs/CURVE.md.
// Uses the same ceiling division, so any rounding drift shows up here.  `node contracts/sim.mjs`

const BPS = 10_000n, FEE_BPS = 100n, E18 = 10n ** 18n;
const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const usd = (w) => '$' + (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });

function run(label, virtualUsdcWhole) {
  let vU = BigInt(virtualUsdcWhole) * E18;
  let vT = 1_073_000_000n * E18;
  let rT = 793_100_000n * E18;
  const supply = 1_000_000_000n * E18;
  const startVU = vU, startVT = vT;

  const startPrice = (vU * E18) / vT;
  let paid = 0n, got = 0n, fees = 0n;

  // Buy the whole curve in 500 equal-value slices, exactly as buy() computes it.
  const slice = 30n * E18;
  let guard = 0;
  while (rT > 0n && guard++ < 2_000_000) {
    let inAmt = slice;
    // last slice: shrink to exactly what's left (mirrors maxBuyIn)
    const newVTfull = vT - rT;
    const maxNet = ceilDiv(startVU * startVT, newVTfull) - vU;
    const maxIn = ceilDiv(maxNet * BPS, BPS - FEE_BPS);
    if (inAmt > maxIn) inAmt = maxIn;

    const fee = (inAmt * FEE_BPS) / BPS;
    const net = inAmt - fee;
    const nVU = vU + net;
    const nVT = ceilDiv(vU * vT, nVU);
    const out = vT - nVT;
    if (out === 0n) break;

    vU = nVU; vT = nVT; rT -= out;
    paid += inAmt; got += out; fees += fee;
  }

  const endPrice = (vU * E18) / vT;
  const raised = paid - fees;
  const lpTokens = supply - got;

  console.log(`\n── ${label}: virtualUsdc = $${virtualUsdcWhole.toLocaleString()} ──`);
  console.log(`  paid in total        ${usd(paid)}`);
  console.log(`  fees (1%)            ${usd(fees)}`);
  console.log(`  raised into curve    ${usd(raised)}`);
  console.log(`  tokens sold          ${(Number(got / E18)).toLocaleString()}  (${(Number(got * 10000n / supply) / 100).toFixed(2)}%)`);
  console.log(`  tokens left for LP   ${(Number(lpTokens / E18)).toLocaleString()}`);
  console.log(`  start mcap           ${usd((startPrice * supply) / E18)}`);
  console.log(`  graduation mcap      ${usd((endPrice * supply) / E18)}`);
  console.log(`  price multiple       ${(Number(endPrice * 1000n / startPrice) / 1000).toFixed(2)}x`);
  return { raised, lpTokens };
}

console.log('Hexapus curve simulation — shape fixed at pump.fun ratios, quote side rescaled to USDC');
const presets = [
  ['Opens $932', 1_000],
  ['Opens $2,000 (default)', 2_146],
  ['Opens $2,796', 3_000],
  ['Opens $4,660 (pump.fun parity)', 5_000],
].map(([label, x]) => [label, x, run(label, x)]);

// The invariant that matters: a buy immediately followed by a sell must never profit.
console.log('\n── round-trip: rounding must always favour the pool ──');
{
  let vU = 3_000n * E18, vT = 1_073_000_000n * E18;
  let worst = null;
  for (const amt of [1n, 1000n, 10n ** 9n, E18, 100n * E18, 5_000n * E18]) {
    const fee = (amt * FEE_BPS) / BPS;
    const net = amt - fee;
    const nVU = vU + net;
    const nVT = ceilDiv(vU * vT, nVU);
    const out = vT - nVT;
    // sell it straight back, zero tax, zero fee — the most generous case possible
    const back = nVU - ceilDiv(nVU * nVT, nVT + out);
    const delta = back - net;
    const ok = delta <= 0n;
    if (!ok) worst = amt;
    console.log(`  in ${String(amt).padStart(22)}  net→back delta ${String(delta).padStart(4)}  ${ok ? 'OK' : 'PROFIT — BUG'}`);
  }
  console.log(worst === null ? '  all round-trips lose to the pool' : `  FAILED at ${worst}`);
}

// ── migration: replays LiquidityMigrator's Q64.96 math ────────────────────────
// The pool must open at the price the curve closed at. Any gap is a free arbitrage
// handed to whoever is watching the migration transaction.
console.log('\n── migration: does the v3 pool open where the curve closed? ──');
{
  const isqrt = (n) => {                       // same Babylonian as LiquidityMigrator._sqrt
    if (n === 0n) return 0n;
    let z = n, y = (n >> 1n) + 1n;
    while (y < z) { z = y; y = (n / y + y) >> 1n; }
    return z;
  };
  const Q96 = 2n ** 96n;
  const USDC = 0x3600000000000000000000000000000000000000n;

  for (const [label, X, { raised, lpTokens }] of presets) {
    const usdc6 = raised / 10n ** 12n;         // 18-dec native -> 6-dec ERC-20, floored
    // Token address is CREATE2-derived, so ordering is not knowable in advance. Check both.
    for (const tokenIsToken0 of [true, false]) {
      const [a0, a1] = tokenIsToken0 ? [lpTokens, usdc6] : [usdc6, lpTokens];
      const sqrtPriceX96 = isqrt((a1 << 96n) / a0) << 48n;

      // Recover the price the pool will open at, as USDC per whole token.
      // Scale by 1e36 before dividing: when the token is token0 the raw ratio is ~1e-17,
      // and a plain BigInt division truncates it to zero rather than to a small number.
      const num = sqrtPriceX96 * sqrtPriceX96;
      const ratio = Number((num * 10n ** 36n) / (Q96 * Q96)) / 1e36; // amount1 / amount0
      const poolPrice = tokenIsToken0 ? ratio * 1e12 : 1e12 / ratio;
      const depositPrice = Number(usdc6) / 1e6 / (Number(lpTokens / 10n ** 18n));
      const drift = Math.abs(poolPrice - depositPrice) / depositPrice;

      const L = (isqrt(a0 * a1) * 999n) / 1000n;
      const fitsU128 = L < 2n ** 128n;
      if (tokenIsToken0) {
        console.log(`  ${label.padEnd(24)} deposit $${depositPrice.toExponential(5)}/token` +
                    `  L=${L}  ${fitsU128 ? 'fits uint128' : 'OVERFLOWS uint128'}`);
      }
      console.log(`     token${tokenIsToken0 ? '0' : '1'} ordering: pool opens $${poolPrice.toExponential(5)}` +
                  `  drift ${(drift * 100).toFixed(4)}%  ${drift < 0.001 ? 'OK' : 'GAP — ARB'}`);
    }
  }

  console.log('\n  Why the split is 793.1M / 206.9M and not a round number:');
  const X = 1n;
  const endPriceCoef = 3.83351 / 279_900_000;   // virtualUsdc_end / virtualTokens_end
  const depositCoef = 2.83351 / 206_900_000;    // raised / lpTokens
  console.log(`    curve's closing price  = virtualUsdc_0 x ${endPriceCoef.toExponential(6)}`);
  console.log(`    pool's opening price   = virtualUsdc_0 x ${depositCoef.toExponential(6)}`);
  console.log(`    they differ by ${(Math.abs(endPriceCoef - depositCoef) / depositCoef * 100).toFixed(4)}% ` +
              `- the leftover supply prices itself at the graduation price by construction.`);
}
