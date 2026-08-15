/**
 * Unified balance, driven by the browser wallet.
 *
 * The Swap page pays for a coin with USDC that may be sitting on any supported chain. Circle's
 * unified balance is the accounting layer that makes that one number: the USDC still lives where
 * it was deposited, and `spend` burns from those chains and mints on Arc when it is needed.
 *
 * App Kit rather than the standalone Unified Balance Kit — the same package carries swap, which
 * is the next thing this page needs for tokens that are not USDC.
 *
 * No wagmi. Its only job in the reference integration is handing the adapter an EIP-1193
 * provider, and this site already has one in `window.ethereum`.
 */
import { AppKit } from '@circle-fin/app-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { createPublicClient, http, formatUnits } from 'viem';

const kit = new AppKit();

/**
 * Chains the unified balance is read across.
 *
 * `chain` is the SDK's own identifier, read out of the installed package rather than guessed —
 * an unrecognised name fails at spend time with funds already committed. The numeric id is what
 * `wallet_switchEthereumChain` needs, since the burn is signed on the source chain.
 */
export const CHAINS = [
  { chain: 'Arc_Testnet', id: 5042002, name: 'Arc Testnet',
    rpc: 'https://rpc.testnet.arc.network', explorer: 'https://testnet.arcscan.app',
    symbol: 'USDC', decimals: 18 },
  { chain: 'Base_Sepolia', id: 84532, name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    symbol: 'ETH', decimals: 18 },
  { chain: 'Ethereum_Sepolia', id: 11155111, name: 'Ethereum Sepolia',
    // rpc.sepolia.org stopped answering; publicnode is reachable and sends CORS headers.
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
    symbol: 'ETH', decimals: 18 },
  { chain: 'Arbitrum_Sepolia', id: 421614, name: 'Arbitrum Sepolia',
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io',
    symbol: 'ETH', decimals: 18 },
  { chain: 'Optimism_Sepolia', id: 11155420, name: 'OP Sepolia',
    rpc: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io',
    symbol: 'ETH', decimals: 18 },
  { chain: 'Avalanche_Fuji', id: 43113, name: 'Avalanche Fuji',
    rpc: 'https://api.avax-test.network/ext/bc/C/rpc', explorer: 'https://testnet.snowtrace.io',
    symbol: 'AVAX', decimals: 18 },
  { chain: 'Polygon_Amoy_Testnet', id: 80002, name: 'Polygon Amoy',
    rpc: 'https://rpc-amoy.polygon.technology', explorer: 'https://amoy.polygonscan.com',
    symbol: 'POL', decimals: 18 },
  { chain: 'Unichain_Sepolia', id: 1301, name: 'Unichain Sepolia',
    rpc: 'https://sepolia.unichain.org', explorer: 'https://sepolia.uniscan.xyz',
    symbol: 'ETH', decimals: 18 },
  { chain: 'World_Chain_Sepolia', id: 4801, name: 'World Chain Sepolia',
    rpc: 'https://worldchain-sepolia.g.alchemy.com/public',
    explorer: 'https://worldchain-sepolia.explorer.alchemy.com', symbol: 'ETH', decimals: 18 },
  { chain: 'Sei_Testnet', id: 1328, name: 'Sei Testnet',
    rpc: 'https://evm-rpc-testnet.sei-apis.com', explorer: 'https://seitrace.com',
    symbol: 'SEI', decimals: 18 },
  { chain: 'Sonic_Testnet', id: 64165, name: 'Sonic Testnet',
    rpc: 'https://rpc.testnet.soniclabs.com', explorer: 'https://testnet.sonicscan.org',
    symbol: 'S', decimals: 18 },
  { chain: 'HyperEVM_Testnet', id: 998, name: 'HyperEVM Testnet',
    rpc: 'https://rpc.hyperliquid-testnet.xyz/evm', explorer: 'https://testnet.purrsec.com',
    symbol: 'HYPE', decimals: 18 },
];

/**
 * Solana Devnet is a Gateway chain too, but reaching it needs `@circle-fin/adapter-solana` and a
 * Solana wallet. This page drives one EIP-1193 provider, so it is out of scope until there is a
 * second connector to hand it — listing it here would only produce a chain that never resolves.
 */

/**
 * USDC per chain, for reading what the wallet is holding before any of it is deposited.
 *
 * Every address here was checked against its own chain — `symbol()` returned USDC and
 * `decimals()` returned 6 — rather than copied from a list. A wrong address does not error, it
 * quietly reports a zero balance, which is the kind of bug someone only finds when their money
 * appears to be missing. Chains without a verified entry report nothing instead of a zero.
 */
const USDC = {
  Ethereum_Sepolia:     '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  Base_Sepolia:         '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  Arbitrum_Sepolia:     '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  Optimism_Sepolia:     '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  Avalanche_Fuji:       '0x5425890298aed601595a70AB815c96711a31Bc65',
  Unichain_Sepolia:     '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  World_Chain_Sepolia:  '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88',
  Sei_Testnet:          '0x4fCF1784B31630811181f670Aea7A7bEF803eaED',
};

const BALANCE_OF = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }],
}];

/**
 * What the wallet holds on each chain, which is a different question from the unified balance:
 * this is money that has *not* been deposited yet. Shown so "Unified balance 0.00" stops looking
 * like a bug when the USDC is plainly sitting on Base.
 *
 * Every chain is asked in parallel and failures are swallowed per chain — a public RPC being
 * down or refusing CORS must not blank the other eleven rows.
 */
export async function walletUsdc(address) {
  const out = {};
  await Promise.all(CHAINS.map(async (c) => {
    try {
      const client = createPublicClient({ transport: http(c.rpc, { timeout: 8000, retryCount: 0 }) });
      // Arc's USDC is the native token, so it is a balance read rather than an ERC-20 call.
      const raw = c.chain === ARC.chain
        ? await client.getBalance({ address })
        : USDC[c.chain]
          ? await client.readContract({ address: USDC[c.chain], abi: BALANCE_OF,
                                        functionName: 'balanceOf', args: [address] })
          : null;
      if (raw === null) return;
      out[c.chain] = Number(formatUnits(raw, c.chain === ARC.chain ? 18 : 6));
    } catch { /* chain stays absent, and the row renders as unknown rather than zero */ }
  }));
  return out;
}

export const ARC = CHAINS[0];
export const byChain = (key) => CHAINS.find((c) => c.chain === key);

const provider = () => {
  const p = window.ethereum;
  if (!p) throw new Error('No wallet found. Install MetaMask, then reload.');
  return p;
};

const hex = (n) => '0x' + n.toString(16);

/** Read-only calls need an adapter but not the right network. */
const readAdapter = () => createViemAdapterFromProvider({ provider: provider() });

/** Signing calls do: the burn is submitted on the chain the funds are being taken from. */
async function signingAdapter(chainId) {
  const p = provider();
  const current = await p.request({ method: 'eth_chainId' });
  if (parseInt(current, 16) !== chainId) {
    const c = CHAINS.find((x) => x.id === chainId);
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(chainId) }] });
    } catch (e) {
      // 4902 is the normal first-time path: the wallet has never heard of this network.
      if (e?.code !== 4902 || !c) throw e;
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex(c.id), chainName: c.name, rpcUrls: [c.rpc],
          blockExplorerUrls: [c.explorer],
          nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: c.decimals },
        }],
      });
    }
  }
  return createViemAdapterFromProvider({ provider: provider() });
}

/**
 * The one number the page spends, plus where it actually sits.
 *
 * Returns `{ total, byChain }` with amounts as strings — the SDK reports USDC to 6 decimals and
 * reformatting through a float here would quietly round somebody's balance.
 */
export async function balances() {
  const adapter = await readAdapter();
  const res = await kit.unifiedBalance.getBalances({
    sources: { adapter },
    networkType: 'testnet',
  });
  const rows = res?.breakdown?.[0]?.breakdown ?? [];
  return {
    total: res?.totalConfirmedBalance ?? '0',
    byChain: rows
      .map((r) => ({ chain: r.chain, amount: r.confirmedBalance, name: byChain(r.chain)?.name ?? r.chain }))
      .filter((r) => Number(r.amount) > 0),
  };
}

/** USDC already on Arc needs no Gateway round trip — it is spendable where it stands. */
export const onArc = (b) => Number(b.byChain.find((r) => r.chain === ARC.chain)?.amount ?? 0);

/**
 * Add USDC on a given chain to the unified balance.
 *
 * Needed once per chain before that chain's funds can back a spend — money merely sitting in the
 * wallet is not in the unified balance yet.
 */
export async function deposit({ chain, amount }) {
  const c = byChain(chain);
  if (!c) throw new Error(`Unknown chain ${chain}`);
  const adapter = await signingAdapter(c.id);
  return kit.unifiedBalance.deposit({ from: { adapter, chain }, amount: String(amount) });
}

/**
 * Pull `amount` USDC from the chains it is spread over and mint it on Arc.
 *
 * The Forwarding Service submits the destination mint, so the wallet signs once — on the source
 * chain — and never has to be switched to Arc to collect. `allocations` names which chain the
 * burn comes from; the caller picks it from the breakdown rather than the SDK guessing.
 */
export async function spendToArc({ from, amount, recipient }) {
  const c = byChain(from);
  if (!c) throw new Error(`Unknown chain ${from}`);
  const adapter = await signingAdapter(c.id);
  return kit.unifiedBalance.spend({
    from: { adapter, allocations: { amount: String(amount), chain: from } },
    to: { chain: ARC.chain, recipientAddress: recipient, useForwarder: true },
    amount: String(amount),
  });
}
