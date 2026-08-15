/**
 * Change one launch default on the deployed factory.
 *
 *   node scripts/set-defaults.mjs creatorMaxBps=10000
 *   node scripts/set-defaults.mjs maxBuyBps=50 guardBlocks=300
 *
 * `setDefaults` takes the whole struct, so the current values are read back from the chain and
 * only the named fields are replaced. Passing seven numbers by hand is how one of them ends up
 * silently reset — this makes that impossible.
 *
 * Only affects coins launched *after* the change. A curve copies the defaults at initialize()
 * and never reads them again, so nothing already live moves.
 *
 * Run by the factory owner. The key is read from .env and never printed.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env, normalizeKey } from './env.mjs';

const CHAIN_ID = Number(env('ARC_CHAIN_ID') ?? 5042002);
const RPC = env('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.network';

const FIELDS = ['guardBlocks', 'taxBlocks', 'maxBuyBps', 'sellTaxStartBps',
                'sellTaxFloorBps', 'creatorMaxBps', 'minBuyIn'];

const wanted = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.split('=');
  if (!FIELDS.includes(k) || v === undefined) {
    console.error(`Bad argument "${a}". Expected one of:\n  ${FIELDS.join('\n  ')}`);
    process.exit(1);
  }
  return [k, BigInt(v)];
}));
if (!Object.keys(wanted).length) {
  console.error('Nothing to change. Example: node scripts/set-defaults.mjs creatorMaxBps=10000');
  process.exit(1);
}

const arc = defineChain({
  id: CHAIN_ID, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const dep = JSON.parse(readFileSync(`deployments/${CHAIN_ID}.json`, 'utf8'));
const abi = JSON.parse(readFileSync('out/HexaFactory.json', 'utf8')).abi;
const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const account = privateKeyToAccount(normalizeKey(env('PRIVATE_KEY')));
const wallet = createWalletClient({ account, chain: arc, transport: http(RPC) });

const owner = await pub.readContract({ address: dep.factory, abi, functionName: 'owner' });
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`Not the factory owner.\n  factory owner: ${owner}\n  this key:      ${account.address}`);
  process.exit(1);
}

const current = await pub.readContract({ address: dep.factory, abi, functionName: 'defaults' });
const before = Object.fromEntries(FIELDS.map((f, i) => [f, BigInt(current[i])]));
const after = { ...before, ...wanted };

console.log(`factory ${dep.factory} on chain ${CHAIN_ID}\n`);
for (const f of FIELDS) {
  const changed = before[f] !== after[f];
  console.log(`  ${f.padEnd(17)} ${String(before[f]).padStart(20)}` +
              (changed ? `  ->  ${after[f]}` : ''));
}
if (FIELDS.every((f) => before[f] === after[f])) {
  console.log('\nAlready set. Nothing sent.');
  process.exit(0);
}

const hash = await wallet.writeContract({
  address: dep.factory, abi, functionName: 'setDefaults',
  args: [FIELDS.map((f) => after[f])],
});
console.log(`\nsent ${hash}`);
const rc = await pub.waitForTransactionReceipt({ hash });
console.log(rc.status === 'success' ? 'confirmed' : 'REVERTED');

// Read it back rather than trusting the receipt: a successful transaction that wrote the wrong
// struct looks identical from here.
const now = await pub.readContract({ address: dep.factory, abi, functionName: 'defaults' });
const ok = FIELDS.every((f, i) => BigInt(now[i]) === after[f]);
console.log(ok ? 'verified on chain' : 'MISMATCH — read back does not equal what was sent');
process.exit(ok ? 0 : 1);
