/**
 * Backfills `deployBlock` into an existing deployments/<chainId>.json.
 *
 * Only needed for deployments made before the deploy script started recording it. Finds the
 * earliest block at which the factory has code, by binary search — about 18 requests for a
 * 200k block window, versus the thousands the indexer would otherwise waste scanning empty
 * history.
 *
 *   node scripts/findDeployBlock.mjs
 */
import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RPC_URL = process.env.RPC_URL || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const WINDOW = BigInt(process.env.SEARCH_WINDOW ?? 500_000);

const client = createPublicClient({ transport: http(RPC_URL) });
const chainId = await client.getChainId();
const path = join(ROOT, 'deployments', `${chainId}.json`);

const dep = JSON.parse(readFileSync(path, 'utf8'));
if (dep.deployBlock) {
  console.log(`deployments/${chainId}.json already has deployBlock ${dep.deployBlock} — nothing to do`);
  process.exit(0);
}

const address = dep.factory;
const head = await client.getBlockNumber();
const hasCode = async (blockNumber) => {
  const code = await client.getBytecode({ address, blockNumber });
  return code !== undefined && code !== '0x';
};

console.log(`chain ${chainId}  factory ${address}  head ${head}`);

if (!(await hasCode(head))) {
  console.error('No code at the factory address on the current head. Wrong chain or wrong file?');
  process.exit(1);
}

let lo = head > WINDOW ? head - WINDOW : 0n;
if (await hasCode(lo)) {
  console.error(
    `Factory already had code ${WINDOW} blocks ago. Re-run with a larger SEARCH_WINDOW.`,
  );
  process.exit(1);
}

let hi = head;
let probes = 0;
try {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    probes++;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
} catch (e) {
  // Public RPCs often prune state; without archive data this search cannot run.
  console.error(`Historical lookup failed after ${probes} probes: ${e.message.slice(0, 140)}`);
  console.error('Fallback: set START_BLOCK in .env to a block shortly before you deployed.');
  process.exit(1);
}

dep.deployBlock = Number(lo);
writeFileSync(path, JSON.stringify(dep, null, 2));
console.log(`found deployBlock ${lo} in ${probes} probes — written to deployments/${chainId}.json`);
console.log(`the indexer will now start there instead of head-${process.env.BACKFILL_BLOCKS ?? 5000}`);
