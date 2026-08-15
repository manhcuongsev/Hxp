/**
 * Drives one coin all the way through: launch -> buy out the curve -> migrate into a real
 * Uniswap v3 pool -> verify the liquidity is locked. On Arc, against the live deployment.
 *
 *   node scripts/graduate.mjs
 *
 * This is the path anvil cannot prove. Migration moves the raised USDC with an ERC-20
 * transfer out of a balance the curve received as `msg.value` — the same funds under two
 * views, which only Arc actually implements. Everything else has been tested; this has not.
 *
 * Cost is set by VIRTUAL_USDC: raised = VIRTUAL_USDC x 2.83351, plus 1% fees and gas.
 * The default of 10 graduates for about $28.6 all-in.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, defineChain, keccak256, encodeAbiParameters, parseEther, formatEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { env, normalizeKey } from './env.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const art = (n) => JSON.parse(readFileSync(join(ROOT, 'out', `${n}.json`), 'utf8'));
const uni = (n) =>
  JSON.parse(readFileSync(join(ROOT, `node_modules/@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`), 'utf8'));

const RPC_URL = env('RPC_URL') ?? env('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.network';
const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId();
const isLocal = chainId === 31337;
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `${chainId}.json`), 'utf8'));

const chain = defineChain({
  id: chainId, name: isLocal ? 'Anvil' : 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const key = normalizeKey(isLocal ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' : env('PRIVATE_KEY'));
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

const FACTORY = art('HexaFactory').abi, CURVE = art('HexaCurve').abi;
const MIGRATOR = art('LiquidityMigrator').abi, LOCKER = art('LiquidityLocker').abi;
const POOL = uni('UniswapV3Pool').abi, V3FACTORY = uni('UniswapV3Factory').abi;

const send = async (address, abi, functionName, args, value = 0n) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
};
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}${d ? '  ' + d : ''}`); };

const E18 = 10n ** 18n;
const VIRTUAL_USDC = BigInt(env('VIRTUAL_USDC') ?? 10);
const balance0 = await pub.getBalance({ address: account.address });
console.log(`chain ${chainId}  wallet ${account.address}  balance ${formatEther(balance0)}`);
console.log(`target: virtualUsdc $${VIRTUAL_USDC} -> graduates at about $${(Number(VIRTUAL_USDC) * 2.83351).toFixed(2)} raised\n`);

// ── relax the caps for this one launch ──────────────────────────────────────
// The caps are per-launch config baked in at reveal, and this wallet is both creator and
// buyer. creatorMaxBps (3%) would stop it long before the curve is bought out, and with a
// $10 virtual reserve the guard cap of 0.5% of supply costs about $0.047 — unusable.
// Both are relaxed for this coin and restored afterwards. Nothing about migration depends
// on them, and the integration suite already covers both caps properly.
const [gBlocks, tBlocks, maxBuy, taxStart, taxFloor, creatorMax, minBuy] =
  await read(dep.factory, FACTORY, 'defaults');
console.log(`current defaults: guard ${gBlocks} blocks, maxBuy ${maxBuy}bps, creatorMax ${creatorMax}bps, minBuy ${formatEther(minBuy)}`);

/**
 * Restore to the intended production values from .env, NOT to whatever was on-chain when
 * this script started.
 *
 * Snapshotting the live state looks safer and is not: if a previous run was interrupted
 * before its restore, the caps are still disabled, and snapshotting would record "no guard
 * window, no creator cap" as the values to put back — making a temporary hole permanent.
 * Every launch after that would have no anti-snipe at all.
 */
const PROD = {
  guardBlocks: BigInt(env('GUARD_BLOCKS') ?? 300),
  taxBlocks: BigInt(env('TAX_BLOCKS') ?? 3000),
  maxBuyBps: Number(env('MAX_BUY_BPS') ?? 50),
  sellTaxStartBps: Number(env('SELL_TAX_START_BPS') ?? 9000),
  sellTaxFloorBps: Number(env('SELL_TAX_FLOOR_BPS') ?? 100),
  creatorMaxBps: Number(env('CREATOR_MAX_BPS') ?? 300),
  minBuyIn: BigInt(Math.round(Number(env('MIN_BUY_USDC') ?? 0.5) * 1e6)) * 10n ** 12n,
};

// Only guardBlocks is a reliable tell now. creatorMaxBps is 10000 in normal operation — the
// creator cap was removed — so reading it as "a previous run was interrupted" would warn on
// every single run and train the warning out of being read.
if (gBlocks === 0n) {
  console.log('\nWARNING: the factory is currently running with its guard window disabled.');
  console.log('A previous run was probably interrupted before restoring. This run will put');
  console.log(`it back to guard ${PROD.guardBlocks} blocks when it finishes.\n`);
}

let restored = false;
const restore = async () => {
  if (restored) return;
  restored = true;
  await send(dep.factory, FACTORY, 'setDefaults', [PROD]);
  console.log(`restored defaults: guard ${PROD.guardBlocks} blocks, maxBuy ${PROD.maxBuyBps}bps, creatorMax ${PROD.creatorMaxBps}bps`);
};

// An interrupted run must not leave the factory wide open.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} — restoring caps before exiting`);
    await restore().catch((e) => console.error('RESTORE FAILED, run again to fix:', e.message));
    process.exit(130);
  });
}

try {
  await send(dep.factory, FACTORY, 'setDefaults', [
    { guardBlocks: 0n, taxBlocks: tBlocks, maxBuyBps: 10_000, sellTaxStartBps: taxStart,
      sellTaxFloorBps: taxFloor, creatorMaxBps: 10_000, minBuyIn: minBuy },
  ]);
  console.log('relaxed caps for this launch (guard 0, creatorMax 100%)\n');

  // ── launch ────────────────────────────────────────────────────────────────
  const suffix = Date.now().toString().slice(-4);
  const P = {
    name: `Graduation Test ${suffix}`, symbol: `GRAD${suffix}`, metadataURI: 'ipfs://graduate',
    totalSupply: 1_000_000_000n * E18,
    virtualUsdc: VIRTUAL_USDC * E18,
    virtualTokens: 1_073_000_000n * E18,
    realTokens: 793_100_000n * E18,
  };
  const TUPLE = { type: 'tuple', components: [
    { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'metadataURI', type: 'string' },
    { name: 'totalSupply', type: 'uint256' }, { name: 'virtualUsdc', type: 'uint128' },
    { name: 'virtualTokens', type: 'uint128' }, { name: 'realTokens', type: 'uint128' }] };

  const salt = keccak256(`0x${Date.now().toString(16).padStart(64, '0')}`);
  const commitHash = keccak256(encodeAbiParameters([{ type: 'address' }, TUPLE, { type: 'bytes32' }], [account.address, P, salt]));

  console.log(`launching ${P.symbol}`);
  await send(dep.factory, FACTORY, 'commit', [commitHash]);
  if (isLocal) {
    // anvil only mines on a transaction, so polling for height here would wait forever.
    await pub.request({ method: 'anvil_mine', params: ['0xd'] });
    console.log('  mined 13 blocks past the commit');
  } else {
    const start = await pub.getBlockNumber();
    process.stdout.write('  waiting 12 blocks for the reveal window');
    while ((await pub.getBlockNumber()) < start + 12n) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 600)); }
    console.log();
  }

  // Read the fee rather than assume it: it is owner-settable and this script must not
  // hardcode a number that can drift from the contract.
  const creationFee = await read(dep.factory, FACTORY, 'creationFee');
  if (creationFee > 0n) console.log(`  creation fee ${formatEther(creationFee)} USDC`);
  // The factory forwards the fee to the vault as an ERC-20 transfer out of the value it just
  // received. On Arc those are the same funds; on anvil they are not, so mirror it.
  if (isLocal && creationFee > 0n) {
    await send(dep.usdc, art('MockArcUSDC').abi, 'mint', [dep.factory, creationFee / 10n ** 12n]);
  }
  await send(dep.factory, FACTORY, 'reveal', [P, salt], creationFee);
  const [curve, token] = await read(dep.factory, FACTORY, 'launches', [commitHash]);
  console.log(`  token ${token}\n  curve ${curve}\n`);

  // ── buy out the curve ─────────────────────────────────────────────────────
  console.log('buying out the curve');
  let spent = 0n, rounds = 0;
  while (!(await read(curve, CURVE, 'graduated')) && rounds++ < 60) {
    const maxIn = await read(curve, CURVE, 'maxBuyIn');
    let step = maxIn < parseEther('5') ? maxIn : parseEther('5');
    if (step === 0n) break;
    // The last sliver is smaller than the floor; buy() caps the output at the remainder so
    // sending the floor still completes the curve.
    if (step < minBuy) step = minBuy;
    // anvil keeps msg.value and the ERC-20 balance separate; Arc does not. Mirror it here so
    // the local rehearsal exercises the same code path — and note that on Arc this line does
    // nothing, because the chain has already made the value spendable as USDC.
    if (isLocal) await send(dep.usdc, art('MockArcUSDC').abi, 'mint', [curve, step / 10n ** 12n]);
    await send(curve, CURVE, 'buy', [0n, account.address, '0x0000000000000000000000000000000000000000'], step);
    spent += step;
    process.stdout.write(`\r  ${rounds} buys, $${formatEther(spent)} in, ${formatEther(await read(curve, CURVE, 'realTokens'))} tokens left      `);
  }
  console.log();
  const realUsdc = await read(curve, CURVE, 'realUsdc');
  ok(await read(curve, CURVE, 'graduated'), 'curve graduated', `$${formatEther(realUsdc)} raised in ${rounds} buys`);
  ok((await read(curve, CURVE, 'realTokens')) === 0n, 'curve supply fully sold');

  // THE Arc-specific assertion: the curve took the money as msg.value, and it must be
  // spendable as an ERC-20 balance. On any other chain these would be different pools.
  const curveUsdc6 = await read(dep.usdc, art('MockArcUSDC').abi, 'balanceOf', [curve]);
  ok(curveUsdc6 >= realUsdc / 10n ** 12n,
     'native value received is spendable as USDC ERC-20 (Arc dual view)',
     `erc20 ${curveUsdc6} >= needed ${realUsdc / 10n ** 12n}`);

  // ── migrate ───────────────────────────────────────────────────────────────
  console.log('\nmigrating into Uniswap v3');
  const lpTokens = await read(token, art('HexaToken').abi, 'balanceOf', [curve]);
  const rec = await send(dep.migrator, MIGRATOR, 'migrate', [token]);
  console.log(`  migrate() succeeded, gas ${rec.gasUsed}`);

  const pool = await read(dep.v3Factory, V3FACTORY, 'getPool', [token, dep.usdc, 10000]);
  ok(pool !== '0x0000000000000000000000000000000000000000', 'v3 pool created at the 1% tier', pool);

  const slot0 = await read(pool, POOL, 'slot0');
  const token0 = await read(pool, POOL, 'token0');
  const tokenIsToken0 = getAddress(token0) === getAddress(token);
  const ratio = Number((slot0[0] * slot0[0] * 10n ** 36n) / 2n ** 192n) / 1e36;
  const poolPrice = tokenIsToken0 ? ratio * 1e12 : 1e12 / ratio;
  const depositPrice = Number(realUsdc / 10n ** 12n) / 1e6 / Number(lpTokens / E18);
  ok(Math.abs(poolPrice - depositPrice) / depositPrice < 0.001,
     'pool opens at the price the curve closed at',
     `pool $${poolPrice.toExponential(4)} vs deposit $${depositPrice.toExponential(4)}`);

  ok((await read(token, art('HexaToken').abi, 'balanceOf', [pool])) > 0n, 'pool holds the token side');
  ok((await read(dep.usdc, art('MockArcUSDC').abi, 'balanceOf', [pool])) > 0n, 'pool holds the USDC side');
  ok((await read(dep.locker, LOCKER, 'poolCount')) > 0n, 'locker recorded the position');

  const poolLiquidity = await read(pool, POOL, 'liquidity');
  ok(poolLiquidity > 0n, 'pool has live liquidity', `${poolLiquidity}`);

  let threw = null;
  try { await send(dep.migrator, MIGRATOR, 'migrate', [token]); } catch (e) { threw = e; }
  ok(threw !== null, 'migrating the same coin twice is rejected');

  console.log(`\nexplorer: https://testnet.arcscan.app/address/${pool}`);
  console.log(`token:    https://testnet.arcscan.app/address/${token}`);
} finally {
  await restore();
}

const spentTotal = balance0 - (await pub.getBalance({ address: account.address }));
console.log(`\n${pass} passed, ${fail} failed  —  spent ${formatEther(spentTotal)} USDC all-in`);
process.exit(fail ? 1 : 0);
