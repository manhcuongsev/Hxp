/**
 * Deploys the whole Hexapus stack, plus a Uniswap v3 factory where the chain has none.
 *
 *   RPC_URL=http://127.0.0.1:8545 node scripts/deploy.mjs        # anvil (built-in test key)
 *   node scripts/deploy.mjs                                       # Arc testnet, needs .env
 *
 * On Arc testnet, PRIVATE_KEY must be set in .env and the account funded from
 * https://faucet.circle.com. The key is read from the environment and never printed.
 *
 * On Arc *mainnet* this script must NOT deploy a v3 factory — Uniswap is an official launch
 * partner with a canonical deployment there, and a parallel one would split liquidity
 * against it. Set V3_FACTORY to the canonical address instead. See docs/CURVE.md §5.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, defineChain, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const art = (n) => JSON.parse(readFileSync(join(ROOT, 'out', `${n}.json`), 'utf8'));
const uni = (n) =>
  JSON.parse(readFileSync(join(ROOT, `node_modules/@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`), 'utf8'));

import { env, normalizeKey } from './env.mjs';

const RPC_URL = env('RPC_URL') ?? env('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.network';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
/** anvil's first account — a publicly documented test key, never used for real funds. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId();
const isArc = chainId === 5042002;
const isLocal = chainId === 31337;

if (!isArc && !isLocal) {
  console.error(`refusing to deploy to unknown chain ${chainId}. Expected Arc testnet (5042002) or anvil (31337).`);
  process.exit(1);
}

const key = normalizeKey(isLocal ? ANVIL_KEY : env('PRIVATE_KEY'));

const chain = defineChain({
  id: chainId,
  name: isArc ? 'Arc Testnet' : 'Anvil',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

const balance = await pub.getBalance({ address: account.address });
console.log(`chain ${chainId}  deployer ${account.address}  balance ${formatEther(balance)}`);
if (balance === 0n) {
  console.error(isArc ? 'Deployer has no USDC. Fund it at https://faucet.circle.com (Arc testnet).' : 'Deployer has no funds.');
  process.exit(1);
}

/** Records where the factory landed, so the indexer never scans blocks that predate it. */
let factoryBlock = 0n;

async function deploy(label, artifact, args = []) {
  const bytecode = artifact.bytecode.startsWith('0x') ? artifact.bytecode : `0x${artifact.bytecode}`;
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} deployment reverted`);
  console.log(`  ${label.padEnd(20)} ${r.contractAddress}  (gas ${r.gasUsed})`);
  if (label === 'HexaFactory') factoryBlock = r.blockNumber;
  return r.contractAddress;
}
const send = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
};

console.log('\ndeploying');

// Arc has real USDC at a fixed address; anvil needs the mock that stands in for it.
const usdc = isArc ? ARC_USDC : await deploy('MockArcUSDC', art('MockArcUSDC'));
if (isArc) console.log(`  ${'USDC (native)'.padEnd(20)} ${usdc}  (Arc precompile, not deployed)`);

// Testnet fixture only. Never on Arc mainnet — use the canonical Uniswap deployment.
const v3Factory = env('V3_FACTORY') ?? (await deploy('UniswapV3Factory', uni('UniswapV3Factory')));

const defaults = {
  guardBlocks: BigInt(env('GUARD_BLOCKS') ?? 300),
  taxBlocks: BigInt(env('TAX_BLOCKS') ?? 3000),
  maxBuyBps: Number(env('MAX_BUY_BPS') ?? 50),
  sellTaxStartBps: Number(env('SELL_TAX_START_BPS') ?? 9000),
  sellTaxFloorBps: Number(env('SELL_TAX_FLOOR_BPS') ?? 100),
  creatorMaxBps: Number(env('CREATOR_MAX_BPS') ?? 300),
  // 18-dec native units, same view a payable call sees. 0.5 USDC floor per buy.
  minBuyIn: BigInt(Math.round(Number(env('MIN_BUY_USDC') ?? 0.5) * 1e6)) * 10n ** 12n,
};
const treasury = env('TREASURY') ?? account.address;
// 18-decimal native units, the view a payable call sees. 0.5 USDC by default.
const creationFee = BigInt(Math.round(Number(env('CREATION_FEE_USDC') ?? 0.5) * 1e6)) * 10n ** 12n;

const factory = await deploy('HexaFactory', art('HexaFactory'), [usdc, treasury, defaults, creationFee]);
console.log(`  ${'creation fee'.padEnd(20)} ${Number(creationFee) / 1e18} USDC per launch`);
const vault = await pub.readContract({ address: factory, abi: art('HexaFactory').abi, functionName: 'vault' });
console.log(`  ${'FeeVault'.padEnd(20)} ${vault}  (deployed by the factory)`);

const migrator = await deploy('LiquidityMigrator', art('LiquidityMigrator'), [v3Factory, factory, usdc]);
const locker = await deploy('LiquidityLocker', art('LiquidityLocker'), [migrator, vault, usdc]);

console.log('\nwiring');
await send(migrator, art('LiquidityMigrator').abi, 'setLocker', [locker]);
console.log('  migrator -> locker');
await send(factory, art('HexaFactory').abi, 'setLiquidity', [migrator, locker]);
console.log('  factory  -> migrator + locker (locker registered as a fee creditor)');

const out = {
  chainId, rpc: RPC_URL, deployer: account.address, deployedAt: new Date().toISOString(),
  deployBlock: Number(factoryBlock),
  usdc, v3Factory, factory, vault, migrator, locker, treasury,
  defaults: Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])),
};
mkdirSync(join(ROOT, 'deployments'), { recursive: true });
const path = join(ROOT, 'deployments', `${chainId}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));

console.log(`\nwrote deployments/${chainId}.json  (factory at block ${factoryBlock})`);
console.log(`\nnext: set HEXA_FACTORY_ADDRESS=${factory} in .env, then \`npm run indexer:hexa\``);
console.log('the indexer reads deployBlock from that file, so it starts at the factory, not at head-5000');
