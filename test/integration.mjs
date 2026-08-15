/**
 * End-to-end: commit -> reveal -> buy to graduation -> migrate into Uniswap v3 -> lock -> fees.
 *
 * Runs against a local anvil node using Uniswap's own prebuilt v3-core artifacts, because
 * Arc testnet has no Uniswap deployed and this path has otherwise never been executed.
 *
 * Scope, stated plainly: anvil is a standard EVM and does NOT reproduce Arc's native/ERC-20
 * USDC duality, blocklist enforcement, or burn restrictions. See contracts/mocks/MockArcUSDC.sol.
 * Passing here proves the migration logic works; it does not prove Arc-specific behaviour.
 *
 *   anvil --port 8545 &
 *   node contracts/compile.mjs && node test/integration.mjs
 */
import { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters, encodePacked, parseEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const art = (n) => JSON.parse(readFileSync(join(ROOT, 'out', `${n}.json`), 'utf8'));
const uni = (n) =>
  JSON.parse(readFileSync(join(ROOT, 'node_modules/@uniswap/v3-core/artifacts/contracts', `${n}.sol/${n}.json`), 'utf8'));

// anvil's deterministic accounts: [0] deploys and creates the coin, [1] is an ordinary buyer.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const buyerAcct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const transport = http('http://127.0.0.1:8545');
const wallet = createWalletClient({ account, chain: foundry, transport });
const buyer = createWalletClient({ account: buyerAcct, chain: foundry, transport });
const pub = createPublicClient({ chain: foundry, transport });

let passed = 0, failed = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${msg}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${msg}${detail ? '  ' + detail : ''}`); }
};

async function deploy(artifact, args = []) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.startsWith('0x') ? artifact.bytecode : `0x${artifact.bytecode}`, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('deploy reverted');
  return { address: r.contractAddress, abi: artifact.abi };
}
const sendAs = async (w, c, functionName, args = [], value = 0n) => {
  const hash = await w.writeContract({ address: c.address, abi: c.abi, functionName, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
};
const send = (c, functionName, args = [], value = 0n) => sendAs(wallet, c, functionName, args, value);
const reverts = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const read = (c, functionName, args = []) => pub.readContract({ address: c.address, abi: c.abi, functionName, args });
const mine = (n) => pub.request({ method: 'anvil_mine', params: [`0x${n.toString(16)}`] });

// ── parameters: Ultralight preset from docs/CURVE.md ────────────────────────
const E18 = 10n ** 18n;
const PARAMS = {
  name: 'Hexapus Test Coin',
  symbol: 'HEXT',
  metadataURI: 'ipfs://test',
  totalSupply: 1_000_000_000n * E18,
  virtualUsdc: 1_000n * E18,
  virtualTokens: 1_073_000_000n * E18,
  realTokens: 793_100_000n * E18,
};
const LAUNCH_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
    { name: 'metadataURI', type: 'string' }, { name: 'totalSupply', type: 'uint256' },
    { name: 'virtualUsdc', type: 'uint128' }, { name: 'virtualTokens', type: 'uint128' },
    { name: 'realTokens', type: 'uint128' },
  ],
};

console.log('Hexapus integration — anvil + Uniswap v3-core\n');

// ── deploy ──────────────────────────────────────────────────────────────────
const usdc = await deploy(art('MockArcUSDC'));
const v3Factory = await deploy(uni('UniswapV3Factory'));
const MIN_BUY = parseEther('0.5');
const defaults = {
  guardBlocks: 300n, taxBlocks: 3000n, maxBuyBps: 50, sellTaxStartBps: 9000,
  sellTaxFloorBps: 100, creatorMaxBps: 300, minBuyIn: MIN_BUY,
};
const CREATION_FEE = parseEther('0.5');
const factory = await deploy(art('HexaFactory'), [usdc.address, account.address, defaults, CREATION_FEE]);
const migrator = await deploy(art('LiquidityMigrator'), [v3Factory.address, factory.address, usdc.address]);
const vaultAddr = await read(factory, 'vault');
const locker = await deploy(art('LiquidityLocker'), [migrator.address, vaultAddr, usdc.address]);
await send(migrator, 'setLocker', [locker.address]);
await send(factory, 'setLiquidity', [migrator.address, locker.address]);
console.log('deployed: usdc, v3Factory, hexaFactory, migrator, locker\n');

// ── the locker must have no way to remove liquidity ─────────────────────────
console.log('locker surface');
{
  const names = art('LiquidityLocker').abi.filter((x) => x.type === 'function').map((x) => x.name);
  const forbidden = names.filter((n) => /withdraw|unlock|remove|rescue|emergency|sweep|transferOwner|upgrade/i.test(n));
  ok(forbidden.length === 0, 'no withdraw/unlock/rescue/upgrade function exists', `(${names.join(', ')})`);
  const src = readFileSync(join(ROOT, 'contracts/LiquidityLocker.sol'), 'utf8');
  const burns = [...src.matchAll(/\.burn\(([^)]*)\)/g)].map((m) => m[1]);
  ok(burns.every((a) => a.trim().endsWith('0')), 'every pool.burn call passes a literal zero', burns.join(' | '));
}

// ── commit / reveal ─────────────────────────────────────────────────────────
console.log('\ncommit-reveal');
const salt = keccak256('0xdeadbeef');
const commitHash = keccak256(
  encodeAbiParameters([{ type: 'address' }, LAUNCH_TUPLE, { type: 'bytes32' }], [account.address, PARAMS, salt]),
);
ok(commitHash === (await read(factory, 'hashLaunch', [account.address, PARAMS, salt])),
   'off-chain commit hash matches the contract');

await send(factory, 'commit', [commitHash]);
let threw = null;
try { await send(factory, 'reveal', [PARAMS, salt]); } catch (e) { threw = e; }
ok(threw !== null, 'reveal before COMMIT_MIN_BLOCKS is rejected');

await mine(13);

// The creation fee is charged on reveal, not commit: an abandoned commit produces no coin
// and should cost nothing but its own gas.
const unpaid = await reverts(() => send(factory, 'reveal', [PARAMS, salt]));
ok(unpaid !== null && /CreationFeeUnpaid/.test(String(unpaid)), 'reveal without the creation fee is rejected');

// The fee arrives as msg.value and leaves as an ERC-20 transfer, so the vault must be funded
// the same way a curve funds it — Arc's dual view is what makes that work.
await send(usdc, 'mint', [factory.address, CREATION_FEE / 10n ** 12n]);
await send(factory, 'reveal', [PARAMS, salt], CREATION_FEE);
const launch = await read(factory, 'launches', [commitHash]);
const [curveAddr, tokenAddr] = launch;
const curve = { address: curveAddr, abi: art('HexaCurve').abi };
const token = { address: tokenAddr, abi: art('HexaToken').abi };
ok(getAddress(curveAddr) !== getAddress('0x0000000000000000000000000000000000000000'), 'curve deployed', curveAddr);
ok((await read(token, 'balanceOf', [curveAddr])) === PARAMS.totalSupply, 'entire supply minted to the curve');

{
  const owed = await pub.readContract({ address: vaultAddr, abi: art('FeeVault').abi, functionName: 'owed', args: [account.address] });
  ok(owed === CREATION_FEE / 10n ** 12n, 'creation fee credited to the treasury, claimable', `owed ${owed}`);
}

const ZERO = '0x0000000000000000000000000000000000000000';
/**
 * Arc invariant: value received natively IS the USDC balance, already spendable inside the
 * same call. anvil cannot express that, so the mock is credited immediately *before* the
 * payable call — matching the state buy() would see on Arc, where the fee it pays out is
 * drawn from the value that just arrived.
 */
const buyAs = async (w, from, to, value) => {
  await send(usdc, 'mint', [curveAddr, value / 10n ** 12n]);
  return sendAs(w, curve, 'buy', [0n, to, ZERO], value);
};

// ── the minimum buy actually binds ──────────────────────────────────────────
console.log('\nminimum buy');
{
  const dust = await reverts(() => buyAs(wallet, account.address, account.address, parseEther('0.4')));
  ok(dust !== null && /BelowMinBuy/.test(String(dust)), 'a buy under the floor is rejected', 'tried $0.40');
  const atFloor = await reverts(() => buyAs(wallet, account.address, account.address, MIN_BUY));
  ok(atFloor === null, 'a buy exactly at the floor is accepted', 'sent $0.50');
}

// ── the creator cap actually binds ──────────────────────────────────────────
console.log('\ncreator cap');
{
  await buyAs(wallet, account.address, account.address, parseEther('20'));
  const held = await read(curve, 'creatorHeld');
  ok(held > 0n, 'creator purchases are recorded publicly', `creatorHeld ${(Number(held) / 1e18 / 1e6).toFixed(2)}M`);

  const e = await reverts(() => buyAs(wallet, account.address, account.address, parseEther('2000')));
  ok(e !== null && /CreatorCapExceeded/.test(String(e)),
     'creator cannot exceed creatorMaxBps through the ordinary buy()');
  // Routing to another address dodges the creator cap — the leak documented in SPEC.md §4.
  // Inside the guard window the per-wallet cap catches it anyway, which is the point of
  // having both: the creator cap discloses, the guard cap bounds.
  const e2 = await reverts(() => buyAs(wallet, account.address, buyerAcct.address, parseEther('20')));
  ok(e2 !== null && /GuardCapExceeded/.test(String(e2)),
     'routing around the creator cap still hits the per-wallet guard cap');
}

// ── buy to graduation ───────────────────────────────────────────────────────
console.log('\nbuy to graduation');
await mine(301); // past the guard window so the per-wallet cap stops binding
let spent = parseEther('40'), rounds = 0;
while (!(await read(curve, 'graduated')) && rounds++ < 400) {
  const maxIn = await read(curve, 'maxBuyIn');
  let step = maxIn < parseEther('300') ? maxIn : parseEther('300');
  // Near the end maxBuyIn falls below the floor. buy() caps the output at the remainder, so
  // sending the floor still finishes the curve — it just overpays for the last sliver.
  if (step < MIN_BUY) step = MIN_BUY;
  await buyAs(buyer, buyerAcct.address, buyerAcct.address, step);
  spent += step;
}
const realUsdc = await read(curve, 'realUsdc');
ok(await read(curve, 'graduated'), 'curve graduated', `${rounds} buys, ${(Number(spent) / 1e18).toFixed(2)} USDC in`);
ok((await read(curve, 'realTokens')) === 0n, 'curve supply fully sold');
ok(Math.abs(Number(realUsdc) / 1e18 - 2834.5) < 60,
   'raised lands near the Ultralight target of $2,834', `got $${(Number(realUsdc) / 1e18).toFixed(2)}`);

// ── migrate ─────────────────────────────────────────────────────────────────
console.log('\nmigrate into Uniswap v3');
const lpTokensBefore = await read(token, 'balanceOf', [curveAddr]);
await send(migrator, 'migrate', [tokenAddr]);
const pool = await read(v3Factory, 'getPool', [tokenAddr, usdc.address, 10000]);
ok(pool !== '0x0000000000000000000000000000000000000000', 'v3 pool created at the 1% tier', pool);

const poolC = { address: pool, abi: uni('UniswapV3Pool').abi };
const slot0 = await read(poolC, 'slot0');
const sqrtP = slot0[0];
const token0 = await read(poolC, 'token0');
const tokenIsToken0 = getAddress(token0) === getAddress(tokenAddr);
const ratio = Number((sqrtP * sqrtP * 10n ** 36n) / (2n ** 192n)) / 1e36;
const poolPrice = tokenIsToken0 ? ratio * 1e12 : 1e12 / ratio;
const depositPrice = Number(realUsdc / 10n ** 12n) / 1e6 / Number(lpTokensBefore / E18);
ok(Math.abs(poolPrice - depositPrice) / depositPrice < 0.001,
   'pool opens at the price the curve closed at',
   `pool $${poolPrice.toExponential(4)} vs deposit $${depositPrice.toExponential(4)}`);

ok((await read(token, 'balanceOf', [pool])) > 0n, 'pool holds the token side');
ok((await read(usdc, 'balanceOf', [pool])) > 0n, 'pool holds the USDC side');
ok((await read(locker, 'poolCount')) === 1n, 'locker recorded the position');

threw = null;
try { await send(migrator, 'migrate', [tokenAddr]); } catch (e) { threw = e; }
ok(threw !== null, 'migrating twice is rejected');

// ── the position is genuinely stuck ─────────────────────────────────────────
console.log('\nliquidity is not retrievable');
{
  // v3 keys positions with abi.encodePacked (20 + 3 + 3 bytes), not abi.encode.
  const posKey = keccak256(encodePacked(['address', 'int24', 'int24'], [locker.address, -887200, 887200]));
  const pos = await read(poolC, 'positions', [posKey]);
  const poolLiquidity = await read(poolC, 'liquidity');
  ok(pos[0] > 0n, 'locker owns a live position', `liquidity ${pos[0]}`);
  ok(pos[0] === poolLiquidity, 'the locker holds 100% of the pool liquidity', `pool ${poolLiquidity}`);
  // Nobody else can touch it: burn/collect act on msg.sender's own position.
  const before = await read(poolC, 'positions', [posKey]);
  try { await send(poolC, 'burn', [-887200, 887200, before[0]]); } catch { /* expected */ }
  const after = await read(poolC, 'positions', [posKey]);
  ok(after[0] === before[0], "an outsider's burn cannot touch the locker's position");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
