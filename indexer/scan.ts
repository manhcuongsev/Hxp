/**
 * The content scanner, as its own process on its own machine.
 *
 *   SCAN_TOKEN=<shared secret> npm run scan
 *
 * It holds nothing. Images arrive, are classified, and are dropped — there is no database, no
 * disk, and nothing to migrate. Losing this box costs a rebuild and no data, which is the point:
 * it is the one process whose entire job is opening files sent by strangers.
 *
 * The indexer calls it by setting `SCAN_URL` and the same `SCAN_TOKEN`. With neither set, the
 * indexer classifies in-process and this file is never needed — a development machine, or a
 * deployment small enough not to care, runs exactly as before.
 */
import express from 'express';
import { local, verifyImage } from './moderate.js';

const PORT = Number(process.env.SCAN_PORT ?? 8890);
const TOKEN = process.env.SCAN_TOKEN ?? '';
const MAX = 15 * 1024 * 1024;
const TYPES = new Set(['png', 'jpg', 'webp', 'gif']);

if (!TOKEN) {
  console.error('SCAN_TOKEN is required. Without it anyone who reaches this port can spend its CPU.');
  process.exit(1);
}

const app = express();

/**
 * A shared secret, compared in full every time.
 *
 * Returning early on the first wrong byte leaks the secret to anyone patient enough to measure
 * the difference, so both sides are padded to the same length and every byte is compared.
 */
const sameToken = (given: string) => {
  const a = Buffer.from(given.padEnd(TOKEN.length, '\0').slice(0, TOKEN.length));
  const b = Buffer.from(TOKEN);
  let diff = given.length ^ TOKEN.length;
  for (let i = 0; i < b.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

app.get('/health', (_req, res) => res.json({ role: 'scan', ok: true }));

app.post('/scan', express.raw({ type: () => true, limit: MAX + 1048576 }), async (req, res) => {
  if (!sameToken(String(req.headers['x-scan-token'] ?? ''))) {
    return void res.status(401).json({ error: 'bad token' });
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: 'empty body' });
  if (body.length > MAX) return void res.status(413).json({ error: `over ${MAX / 1048576} MB` });

  try {
    await verifyImage(body, TYPES);
    await local([body]);
    res.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    // 422 is a verdict the indexer should pass on to the uploader; anything else is this box
    // being broken, which the indexer must treat as a refusal rather than a pass.
    const broken = /content check unavailable/.test(msg);
    res.status(broken ? 503 : 422).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`hexapus scanner on :${PORT}`));
