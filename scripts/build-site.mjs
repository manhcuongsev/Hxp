/**
 * Builds the browser bundle and copies the two things the site needs from outside its own
 * directory: the contract ABIs and the deployed addresses.
 *
 * Both are generated artefacts, so copying beats duplicating — an ABI edited by hand in one
 * place and not the other is a bug that only shows up as an unexplained revert.
 *
 *   node scripts/build-site.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ASSETS = join(ROOT, 'site', 'assets');
mkdirSync(ASSETS, { recursive: true });

// ── ABIs ────────────────────────────────────────────────────────────────────
const WANTED = ['HexaFactory', 'HexaCurve', 'HexaToken', 'FeeVault', 'LiquidityLocker', 'LiquidityMigrator'];
const abi = {};
for (const name of WANTED) {
  const p = join(ROOT, 'out', `${name}.json`);
  if (!existsSync(p)) {
    console.error(`missing out/${name}.json — run \`node contracts/compile.mjs\` first`);
    process.exit(1);
  }
  abi[name] = JSON.parse(readFileSync(p, 'utf8')).abi;
}
writeFileSync(join(ASSETS, 'abi.json'), JSON.stringify(abi));
console.log(`abi.json           ${WANTED.length} contracts`);

// ── addresses ───────────────────────────────────────────────────────────────
const CHAIN = process.env.SITE_CHAIN ?? '5042002';
const depPath = join(ROOT, 'deployments', `${CHAIN}.json`);
if (!existsSync(depPath)) {
  console.error(`missing deployments/${CHAIN}.json — run \`npm run deploy\` first`);
  process.exit(1);
}
const dep = JSON.parse(readFileSync(depPath, 'utf8'));
writeFileSync(join(ASSETS, 'deployments.json'), JSON.stringify(dep, null, 2));
console.log(`deployments.json   chain ${dep.chainId}, factory ${dep.factory}`);

// ── runtime config ──────────────────────────────────────────────────────────
/**
 * Where the browser should look for the indexer API.
 *
 * This has to be build-time configurable because the answer differs by deployment: localhost
 * while developing, a public HTTPS origin once hosted. A page served over HTTPS cannot call
 * http://127.0.0.1 at all — browsers block mixed content — so a hosted build with the local
 * default bakes in a site that can never load data.
 */
const hexaApi = process.env.HEXA_API_BASE ?? 'http://127.0.0.1:8880';

// The bundle reads its chain from here too, so a build against a local deployment talks to
// the local chain instead of Arc.
const rpcUrls = process.env.SITE_RPC_URLS
  ? process.env.SITE_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  : dep.chainId === 31337
    ? ['http://127.0.0.1:8545']
    : ['https://rpc.testnet.arc.network', 'https://rpc.testnet.arc.io'];

// Arc ships Multicall3 at the canonical address; a bare anvil does not.
const multicall = dep.chainId !== 31337;

writeFileSync(
  join(ASSETS, 'config.js'),
  `window.HEXA_CONFIG = ${JSON.stringify({ hexaApi, chainId: dep.chainId, rpcUrls, multicall })};\n`,
);
console.log(`config.js          hexaApi ${hexaApi}  chain ${dep.chainId}  rpc ${rpcUrls[0]}  multicall ${multicall}`);
if (process.env.VERCEL && hexaApi.startsWith('http://')) {
  console.warn('  WARNING: a hosted HTTPS page cannot call an http:// API. Set HEXA_API_BASE.');
}

// ── bundle ──────────────────────────────────────────────────────────────────
const out = join(ASSETS, 'web3.bundle.js');
await build({
  entryPoints: [join(ROOT, 'site', 'src', 'web3.js')],
  bundle: true,
  format: 'iife',
  globalName: 'hexa',
  target: ['es2022'],
  minify: true,
  loader: { '.json': 'json' },
  outfile: out,
  logLevel: 'warning',
});
const kb = (readFileSync(out).length / 1024).toFixed(1);
console.log(`web3.bundle.js     ${kb} KB  (window.hexa)`);

// Separate bundle: only the coin terminal draws a chart, and every other page would otherwise
// pay for a charting library it never calls.
const chartOut = join(ASSETS, 'chart.bundle.js');
await build({
  entryPoints: [join(ROOT, 'site', 'src', 'chart.js')],
  bundle: true,
  format: 'iife',
  globalName: 'hexaChart',
  target: ['es2022'],
  minify: true,
  outfile: chartOut,
  logLevel: 'warning',
});
console.log(`chart.bundle.js    ${(readFileSync(chartOut).length / 1024).toFixed(1)} KB  (window.hexaChart)`);

// Third separate bundle: only swap.html loads the Circle SDK, and it is by far the heaviest of
// the three. Folding it into web3.bundle.js would put it on every page load.
const swapOut = join(ASSETS, 'swap.bundle.js');
await build({
  entryPoints: [join(ROOT, 'site', 'src', 'swap.js')],
  bundle: true,
  format: 'iife',
  globalName: 'hexaSwap',
  target: ['es2022'],
  minify: true,
  outfile: swapOut,
  logLevel: 'warning',
});
console.log(`swap.bundle.js     ${(readFileSync(swapOut).length / 1024).toFixed(1)} KB  (window.hexaSwap)`);
