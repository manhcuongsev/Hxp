/**
 * Shared environment handling for the scripts.
 *
 * Both helpers exist because the same two defects appeared twice: `??` letting a blank .env
 * value through as a real one, and a private key rejected for missing its 0x prefix. Fixing
 * them in one file is the only way they stay fixed.
 */

/** `??` is wrong for env vars: a key present-but-blank is "" , not undefined. */
export const env = (name) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

/**
 * Accepts a private key with or without the 0x prefix and validates the shape.
 * Never prints, logs, or returns the value on failure — only its length.
 */
export function normalizeKey(raw, label = 'PRIVATE_KEY') {
  if (!raw) {
    console.error(`${label} is not set. Put it in .env (see .env.example).`);
    console.error('Fund the account at https://faucet.circle.com for Arc testnet.');
    process.exit(1);
  }
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error(
      `${label} must be 64 hex characters (32 bytes), with or without a 0x prefix. ` +
        `Got ${key.length - 2} characters after normalising.`,
    );
    console.error('This is the account key — not an API key, and not a seed phrase.');
    process.exit(1);
  }
  return key;
}
