// Minimal solc driver. `node contracts/compile.mjs`
import solc from 'solc';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.sol') ? [join(d, e.name)] : [],
  );

const sources = {};
for (const f of walk(ROOT)) {
  sources[f.slice(ROOT.length + 1).replace(/\\/g, '/')] = { content: readFileSync(f, 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const findImport = (path) => {
  try {
    return { contents: readFileSync(join(ROOT, path), 'utf8') };
  } catch (e) {
    return { error: `not found: ${path}` };
  }
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

// Kept so verification submits the exact input that produced the deployed bytecode. Rebuilding
// it later from the sources on disk is how "compiled bytecode does not match" happens.
mkdirSync(join(ROOT, '..', 'out'), { recursive: true });
writeFileSync(join(ROOT, '..', 'out', 'standard-input.json'), JSON.stringify(input));
writeFileSync(join(ROOT, '..', 'out', 'solc-version.txt'), solc.version());

const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
const warnings = (out.errors ?? []).filter((e) => e.severity === 'warning');

for (const w of warnings) console.log('WARN ', w.formattedMessage.trim().split('\n')[0]);
for (const e of errors) console.error('ERROR', e.formattedMessage);

if (errors.length) {
  console.error(`\n${errors.length} error(s)`);
  process.exit(1);
}

mkdirSync(join(ROOT, '..', 'out'), { recursive: true });
const sizes = [];
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    const bytes = (c.evm.deployedBytecode.object.length / 2) | 0;
    if (bytes > 0) sizes.push([name, bytes]);
    writeFileSync(join(ROOT, '..', 'out', `${name}.json`), JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object }));
  }
}

console.log(`\nOK — ${warnings.length} warning(s), 0 errors`);
for (const [name, bytes] of sizes.sort((a, b) => b[1] - a[1])) {
  const pct = ((bytes / 24576) * 100).toFixed(1);
  console.log(`  ${name.padEnd(16)} ${String(bytes).padStart(6)} bytes  ${pct}% of EIP-170 limit`);
}
