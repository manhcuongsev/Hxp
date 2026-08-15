import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, webSocket, fallback, defineChain, type Address } from 'viem';

export const ARC_CHAIN_ID = 5042002;

/** USDC ERC-20 view. The native view is the same funds at 18 decimals — never sum them. */
export const USDC: Address = '0x3600000000000000000000000000000000000000';
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Public Arc RPC endpoints, from Arc's own node documentation (the relay endpoints a node
 * follows) plus the one in Circle's SDK docs. Different providers, same network.
 *
 * They are used as a fallback chain rather than a pool: each has its own per-IP quota, so
 * spreading across them multiplies headroom, and a provider going down stops being an
 * outage. Override with ARC_RPC_URL (single) or ARC_RPC_URLS (comma-separated).
 */
const DEFAULT_RPCS = [
  'https://rpc.testnet.arc.network',
  'https://rpc.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
];

const rpcList = (process.env.ARC_RPC_URLS ?? process.env.ARC_RPC_URL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const RPC_URLS = rpcList.length ? rpcList : DEFAULT_RPCS;

export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/**
 * batch: several reads fire together (metadata enrichment, the /curve proxy) and the
 * transport coalesces them into one HTTP request.
 * fallback: on a 429 or an outage from one provider, viem moves to the next rather than
 * failing the call — which is the whole reason to list more than one.
 */
export const client = createPublicClient({
  chain: arc,
  transport: fallback(RPC_URLS.map((url) => http(url, { batch: true })), { retryCount: 1 }),
});

/**
 * Live event feed for the `hexa` role. A WebSocket subscription gives webhook-grade latency
 * with the chain itself as the source, so there is no third party that can drop, duplicate
 * or reorder a delivery. Frames can still be lost across a reconnect, which is what the
 * reconciliation pass exists for — the cursor is always the authority.
 */
export const wsClient = createPublicClient({
  chain: arc,
  transport: webSocket(process.env.ARC_WS_URL ?? 'wss://rpc.testnet.arc.network', {
    reconnect: { attempts: 20, delay: 2_000 },
    keepAlive: { interval: 20_000 },
  }),
});

export type Role = 'hexa' | 'network';

/**
 * Written by scripts/deploy.mjs. `deployBlock` is the point before which the factory did not
 * exist — scanning earlier is guaranteed to find nothing and, on a public RPC, is the
 * fastest way to get rate limited for no reason.
 */
type Deployment = { chainId: number; factory: Address; deployBlock: number };

export function loadDeployment(chainId: number): Deployment | null {
  try {
    return JSON.parse(readFileSync(`deployments/${chainId}.json`, 'utf8')) as Deployment;
  } catch {
    return null;
  }
}

const deployment = loadDeployment(ARC_CHAIN_ID);
const envFactory = (process.env.HEXA_FACTORY_ADDRESS || undefined) as Address | undefined;

/**
 * The deployment file is the source of truth for which factory is current, because the
 * deploy script writes it and nothing else does. `.env` is an override for pointing at an
 * older deployment on purpose.
 *
 * They are allowed to differ, but silently is not one of the options: a redeploy that leaves
 * a stale address in .env has the indexer and the site watching two different factories,
 * each convinced it is right.
 */
export const factoryMismatch =
  envFactory && deployment?.factory && envFactory.toLowerCase() !== deployment.factory.toLowerCase()
    ? { env: envFactory, deployed: deployment.factory }
    : null;

const role = (process.env.INDEXER_ROLE ?? 'network') as Role;

export const config = {
  role,
  /**
   * Per-role defaults live here rather than in the npm scripts. Baking them into
   * `cross-env HEXA_STATE_DIR=data-hexa` meant the script overrode whatever the caller set,
   * so switching to a fresh database when the factory changes — the exact thing the mismatch
   * warning tells you to do — silently kept reading the old one.
   */
  port: Number(process.env.INDEXER_PORT ?? (role === 'hexa' ? 8880 : 8881)),
  stateDir: process.env.HEXA_STATE_DIR ?? (role === 'hexa' ? 'data-hexa' : 'data-network'),
  factory: envFactory ?? deployment?.factory,
  /** 0 = start near head instead of genesis. Arc has sub-second blocks; genesis is far away. */
  startBlock: BigInt(process.env.START_BLOCK ?? 0),
  backfillBlocks: BigInt(process.env.BACKFILL_BLOCKS ?? 5_000),
  chunkSize: BigInt(process.env.CHUNK_SIZE ?? 2_000),
  pollMs: Number(process.env.POLL_MS ?? 1_500),
  /** How often the `hexa` role re-reads the gap between its cursor and head. */
  reconcileMs: Number(process.env.RECONCILE_MS ?? 30_000),
  /** Liveness line, so an exited indexer is distinguishable from a quiet one. */
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 60_000),
};
