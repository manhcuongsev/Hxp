/**
 * Everything the browser needs to talk to Hexapus on Arc. Bundled by scripts/build-site.mjs
 * into site/assets/web3.bundle.js and exposed as `window.hexa`.
 *
 * viem is bundled rather than hand-rolled because `reveal()` requires abi.encode of a tuple
 * containing three strings, hashed to match the commit — the one place where a subtle
 * encoding mistake would produce a hash that silently never matches.
 */
import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  keccak256, encodeAbiParameters, parseEther, formatEther, formatUnits, getAddress,
} from 'viem';

import ABI from '../assets/abi.json';
import DEPLOY from '../assets/deployments.json';

/**
 * Chain and RPC come from assets/config.js, which the build writes from the deployments file.
 * Hardcoding Arc here meant a bundle built against a local deployment still talked to Arc,
 * read an address that exists on neither chain, and reported the contract as unreachable —
 * a dev loop that cannot be run is a dev loop nobody runs.
 */
const CFG = globalThis.HEXA_CONFIG ?? {};

export const ARC = defineChain({
  id: CFG.chainId ?? 5042002,
  name: CFG.chainId === 31337 ? 'Anvil' : 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: CFG.rpcUrls ?? ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

/**
 * Batched through Multicall3, which Arc has at the canonical address.
 *
 * A coin page reads a dozen values at once and refreshes on a timer. Sent individually that
 * is a dozen requests every few seconds from every open tab, and Arc's public RPC answers
 * with 429 — the same rate-limit trap the indexer hit, arrived at from the browser side.
 * Collapsed into one eth_call, it is a dozen times cheaper and stops tripping the limit.
 */
export const pub = createPublicClient({
  chain: ARC,
  // JSON-RPC batching needs no contract: several reads still leave as one HTTP request.
  transport: http(undefined, { batch: true }),
  // Multicall batching collapses them further into a single eth_call, but only works where
  // Multicall3 is actually deployed. Arc has it; a bare anvil does not, and there every read
  // returns "0x" from an address with no code — which reads as "the contract is missing"
  // and sends you looking in entirely the wrong place.
  ...(CFG.multicall === false ? {} : { batch: { multicall: { wait: 20 } } }),
});
export const addresses = DEPLOY;
export const abi = ABI;

let wallet = null;
let account = null;

export const currentAccount = () => account;

/** The chain the wallet is actually on, or null when there is no wallet. */
export let arcMissing = false;

export async function walletChainId() {
  const provider = window.ethereum;
  if (!provider) return null;
  try { return parseInt(await provider.request({ method: 'eth_chainId' }), 16); }
  catch { return null; }
}

/** Ask MetaMask to add Arc if the user has never used it, then switch to it. */
export async function ensureArc(provider = window.ethereum) {
  if (!provider) throw new Error('No wallet found. Install MetaMask.');
  const hex = '0x' + ARC.id.toString(16);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    // 4902 = unrecognised chain. Anything else is the user declining, which must propagate.
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    // There is no way to ask a wallet whether it knows a chain without prompting, so the fact
    // is recorded here the one time it surfaces and the button can then say "Add" rather
    // than "Switch".
    arcMissing = true;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: 'Arc Testnet',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: ARC.rpcUrls.default.http,
        blockExplorerUrls: ['https://testnet.arcscan.app'],
      }],
    });
  }
}

export async function connect() {
  const provider = window.ethereum;
  if (!provider) throw new Error('No wallet found. Install MetaMask.');
  sessionStorage.removeItem('hexa:disconnected');
  const [addr] = await provider.request({ method: 'eth_requestAccounts' });
  await ensureArc(provider);
  account = getAddress(addr);
  wallet = createWalletClient({ account, chain: ARC, transport: custom(provider) });

  watch(provider);
  return account;
}

/**
 * A chain change only affects signing — every read goes to Arc's own RPC through `pub`, not
 * through the wallet. So it announces itself and lets the page re-gate its buttons, rather than
 * reloading and throwing away whatever the user had typed. Switching accounts is different:
 * that changes whose data is on screen, so it still reloads.
 */
let watching = false;
function watch(provider) {
  if (watching) return;
  watching = true;
  provider.on?.('accountsChanged', () => location.reload());
  provider.on?.('chainChanged', (id) => document.dispatchEvent(
    new CustomEvent('hexa:chain', { detail: parseInt(id, 16) })));
}

/**
 * Forget the wallet on this site.
 *
 * `wallet_revokePermissions` is what actually stops `resume()` from silently reconnecting on the
 * next load — clearing the variables alone would last until the reload. Not every wallet
 * implements it, so the local state is dropped either way and the caller reloads.
 */
export async function disconnect() {
  const provider = window.ethereum;
  try {
    await provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch { /* wallet does not support it; the site still forgets what it knew */ }
  account = null;
  wallet = null;
  sessionStorage.setItem('hexa:disconnected', '1');
}

/** Reconnect silently if the site is already authorised, so a reload does not log you out. */
export async function resume() {
  const provider = window.ethereum;
  if (!provider) return null;
  // An explicit disconnect has to survive the reload that follows it, or the silent reconnect
  // below would sign the user straight back in.
  if (sessionStorage.getItem('hexa:disconnected')) return null;
  const accts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  if (!accts?.length) return null;
  account = getAddress(accts[0]);
  wallet = createWalletClient({ account, chain: ARC, transport: custom(provider) });
  watch(provider);
  return account;
}

export const read = (address, name, fn, args = []) =>
  pub.readContract({ address, abi: abi[name], functionName: fn, args });

export async function write(address, name, fn, args = [], value = 0n) {
  if (!wallet) throw new Error('Connect a wallet first.');
  // Every contract this site writes to lives on Arc. Being on the wrong network is a one-call
  // fix, so fix it rather than surfacing viem's chain-mismatch error to someone who cannot act
  // on it. Declining the switch still propagates.
  if (await walletChainId() !== ARC.id) await ensureArc();
  const hash = await wallet.writeContract({ address, abi: abi[name], functionName: fn, args, value, account, chain: ARC });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${fn} reverted`);
  return receipt;
}

export const LAUNCH_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
    { name: 'metadataURI', type: 'string' }, { name: 'totalSupply', type: 'uint256' },
    { name: 'virtualUsdc', type: 'uint128' }, { name: 'virtualTokens', type: 'uint128' },
    { name: 'realTokens', type: 'uint128' },
  ],
};

/** Must match HexaFactory.hashLaunch exactly, or the reveal never finds its commit. */
export const hashLaunch = (creator, params, salt) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, LAUNCH_TUPLE, { type: 'bytes32' }], [creator, params, salt]));

export const randomSalt = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export { keccak256, parseEther, formatEther, formatUnits, getAddress };
