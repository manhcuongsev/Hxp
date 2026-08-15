/**
 * Publish the contract sources to the Arc explorer.
 *
 *   node scripts/verify.mjs            # the deployed singletons
 *   node scripts/verify.mjs <address>  # one coin's token contract
 *
 * arcscan runs Blockscout, whose v2 API takes a solc standard-JSON input and matches it against
 * the on-chain bytecode. `contracts/compile.mjs` already writes that exact input to
 * out/standard-input.json, so nothing is recompiled here — a rebuild from the sources on disk
 * is what produces "compiled bytecode does not match".
 *
 * Two shapes of contract, verified differently:
 *
 *   - HexaCurve is deployed once as a template and then cloned per coin (EIP-1167). Verifying
 *     the template is enough: the explorer recognises a minimal proxy and shows the template's
 *     source for every clone.
 *   - HexaToken is a real deployment per coin, identical bytecode with different constructor
 *     arguments. Verifying one teaches Blockscout the bytecode, and it marks later coins as
 *     matching on its own — this script can also be pointed at a specific token to force it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CHAIN = process.env.SITE_CHAIN ?? '5042002';
const EXPLORER = process.env.ARC_EXPLORER ?? 'https://testnet.arcscan.app';

const inputPath = join(ROOT, 'out', 'standard-input.json');
if (!existsSync(inputPath)) {
  console.error('out/standard-input.json is missing — run `node contracts/compile.mjs` first.');
  process.exit(1);
}
const standardInput = readFileSync(inputPath, 'utf8');
const solcVersion = readFileSync(join(ROOT, 'out', 'solc-version.txt'), 'utf8').trim();
// Blockscout wants the release tag it knows: "0.8.28+commit.7893614a".
const compiler = 'v' + solcVersion.replace(/\.Emscripten\.clang$/, '');

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments', `${CHAIN}.json`), 'utf8'));

/** Already verified contracts are a 200 with a source, not an error — skip them quietly. */
async function isVerified(address) {
  const r = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`);
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return Boolean(j.is_verified);
}

async function verify(address, name, contractPath) {
  if (!address) return { name, skipped: 'not deployed' };
  if (await isVerified(address)) return { name, address, status: 'already verified' };

  const body = new FormData();
  body.set('compiler_version', compiler);
  body.set('contract_name', `${contractPath}:${name}`);
  body.set('autodetect_constructor_args', 'true');
  body.set('license_type', 'mit');
  body.set('files[0]', new Blob([standardInput], { type: 'application/json' }), 'standard-input.json');

  const r = await fetch(
    `${EXPLORER}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: 'POST', body },
  );
  const text = await r.text();
  return { name, address, status: r.status, response: text.slice(0, 200) };
}

const targets = [
  [deployments.factory, 'HexaFactory', 'HexaFactory.sol'],
  [deployments.vault, 'FeeVault', 'FeeVault.sol'],
  [deployments.migrator, 'LiquidityMigrator', 'LiquidityMigrator.sol'],
  [deployments.locker, 'LiquidityLocker', 'LiquidityLocker.sol'],
  [deployments.curveTemplate, 'HexaCurve', 'HexaCurve.sol'],
];

const arg = process.argv[2];
if (arg) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) {
    console.error(`Not an address: ${arg}`);
    process.exit(1);
  }
  console.log(await verify(arg, 'HexaToken', 'HexaToken.sol'));
} else {
  console.log(`solc ${compiler} · ${EXPLORER}\n`);
  for (const [address, name, path] of targets) {
    const out = await verify(address, name, path);
    console.log(`${name.padEnd(18)} ${out.address ?? ''} ${out.status ?? out.skipped}`);
    if (out.response && String(out.status) !== '200') console.log(`  ${out.response}`);
  }
}
