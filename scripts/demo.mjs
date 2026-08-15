/**
 * Launches a coin and produces referred buys, so the Booster feed has something real to show.
 *
 *   RPC_URL=http://127.0.0.1:8545 node scripts/demo.mjs
 *
 * On anvil the mock USDC is credited before each payable call, standing in for Arc's rule
 * that value received natively is the same funds as the USDC balance. On Arc that mirroring
 * is skipped because the chain does it for real.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, defineChain, keccak256, encodeAbiParameters, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { env, normalizeKey } from './env.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const art = (n) => JSON.parse(readFileSync(join(ROOT, 'out', `${n}.json`), 'utf8'));

const RPC_URL = process.env.RPC_URL ?? process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId();
const isLocal = chainId === 31337;
const dep = JSON.parse(readFileSync(join(ROOT, 'deployments', `${chainId}.json`), 'utf8'));

// anvil's documented test keys locally; on Arc the creator is yours and the buyer defaults
// to the same wallet, which is fine because the demo stays well inside every cap.
const ANVIL = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // creator
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // buyer
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // referrer
];
/**
 * The referrer only ever accrues a claim in the FeeVault, so it needs no funds and no key
 * here. Defaults to anvil's third account — a publicly known test address, deterministic
 * across runs, and one whose key is public if the credited fees are ever worth claiming.
 * The contract rejects a referrer equal to the trader, so this must differ from the buyer.
 */
const DEMO_REFERRER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const chain = defineChain({
  id: chainId, name: isLocal ? 'Anvil' : 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const w = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC_URL) });
const creator = w(normalizeKey(isLocal ? ANVIL[0] : env('PRIVATE_KEY')));
const buyer = w(normalizeKey(isLocal ? ANVIL[1] : (env('BUYER_KEY') ?? env('PRIVATE_KEY')), 'BUYER_KEY'));
const referrer = isLocal ? privateKeyToAccount(ANVIL[2]).address : (env('REFERRER_ADDRESS') ?? DEMO_REFERRER);

if (referrer.toLowerCase() === buyer.account.address.toLowerCase()) {
  console.error('REFERRER_ADDRESS must differ from the buyer — the contract ignores self-referral.');
  process.exit(1);
}

const send = async (wc, address, abi, functionName, args, value = 0n) => {
  const hash = await wc.writeContract({ address, abi, functionName, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
};

const E18 = 10n ** 18n;
const suffix = Date.now().toString().slice(-5);
const PARAMS = {
  name: `Booster Demo ${suffix}`,
  symbol: `BST${suffix.slice(-3)}`,
  metadataURI: 'ipfs://demo',
  totalSupply: 1_000_000_000n * E18,
  virtualUsdc: 2_146n * E18,          // opens at $2,000 mcap — the default, docs/CURVE.md
  virtualTokens: 1_073_000_000n * E18,
  realTokens: 793_100_000n * E18,
};
const TUPLE = {
  type: 'tuple',
  components: [
    { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
    { name: 'metadataURI', type: 'string' }, { name: 'totalSupply', type: 'uint256' },
    { name: 'virtualUsdc', type: 'uint128' }, { name: 'virtualTokens', type: 'uint128' },
    { name: 'realTokens', type: 'uint128' },
  ],
};

const salt = keccak256(`0x${Date.now().toString(16).padStart(64, '0')}`);
const commitHash = keccak256(
  encodeAbiParameters([{ type: 'address' }, TUPLE, { type: 'bytes32' }], [creator.account.address, PARAMS, salt]),
);

console.log(`chain ${chainId}  factory ${dep.factory}`);
console.log(`launching ${PARAMS.symbol} (${PARAMS.name})`);

await send(creator, dep.factory, art('HexaFactory').abi, 'commit', [commitHash]);
console.log('  committed — nothing about the coin is public yet');

if (isLocal) await pub.request({ method: 'anvil_mine', params: ['0xd'] });
else {
  process.stdout.write('  waiting 12 blocks');
  const start = await pub.getBlockNumber();
  while ((await pub.getBlockNumber()) < start + 12n) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 700)); }
  console.log();
}

const creationFee = await pub.readContract({
  address: dep.factory, abi: art('HexaFactory').abi, functionName: 'creationFee',
});
if (creationFee > 0n) console.log(`  creation fee ${Number(creationFee) / 1e18} USDC`);
// Same Arc-duality mirror as the curve: the factory pays the vault by ERC-20 transfer out of
// the value it just received, which only coincides on Arc.
if (isLocal && creationFee > 0n) {
  await send(creator, dep.usdc, art('MockArcUSDC').abi, 'mint', [dep.factory, creationFee / 10n ** 12n]);
}
await send(creator, dep.factory, art('HexaFactory').abi, 'reveal', [PARAMS, salt], creationFee);
const launch = await pub.readContract({ address: dep.factory, abi: art('HexaFactory').abi, functionName: 'launches', args: [commitHash] });
const [curve, token] = launch;
console.log(`  revealed  token ${token}\n            curve ${curve}`);

const mirrorArc = async (v) => {
  if (!isLocal) return;
  await send(creator, dep.usdc, art('MockArcUSDC').abi, 'mint', [curve, v / 10n ** 12n]);
};

/**
 * Buys stay small and all land inside the guard window, which keeps the demo cheap and
 * removes any waiting.
 *
 * Two caps bound one wallet here. The per-wallet guard cap is maxBuyBps of supply (0.5%),
 * and at the Ultralight opening price 0.5% of supply costs only about **$4.73** — the curve
 * starts that cheap, so a modest dollar amount is already a large share of supply. If the
 * buyer is also the creator, creatorMaxBps (3%) applies on top. The default $3 total sits
 * comfortably under both, so nothing has to wait 300 blocks for the window to elapse.
 *
 * Override with DEMO_BUYS="2,3,4" — but past roughly $4.73 the first cap starts rejecting,
 * which is the cap working, not a misconfiguration.
 */
const AMOUNTS = (env('DEMO_BUYS') ?? '1,1,1').split(',').map((s) => s.trim());

for (const [i, amt] of AMOUNTS.entries()) {
  const v = parseEther(amt);
  await mirrorArc(v);
  // Only the first buy carries the link — that is what emits ReferrerBound. Attribution is
  // first-touch and permanent, so every later buy is credited without passing it again.
  const ref = i === 0 ? referrer : '0x0000000000000000000000000000000000000000';
  await send(buyer, curve, art('HexaCurve').abi, 'buy', [0n, buyer.account.address, ref], v);
  console.log(
    i === 0
      ? `  ${buyer.account.address.slice(0, 10)} bought $${amt} via referral from ${referrer.slice(0, 10)}`
      : `  ${buyer.account.address.slice(0, 10)} bought $${amt} more (no link passed, still credited)`,
  );
}

const bound = await pub.readContract({ address: curve, abi: art('HexaCurve').abi, functionName: 'referrerOf', args: [buyer.account.address] });
console.log(`\nreferrerOf(buyer) on-chain = ${bound}`);
console.log(bound.toLowerCase() === referrer.toLowerCase() ? 'matches the referrer' : 'MISMATCH');
console.log(`\ncheck the feed:  curl http://127.0.0.1:8880/booster`);
