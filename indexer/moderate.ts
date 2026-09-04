/**
 * Refuse sexual imagery at upload.
 *
 * Not a moral position, a structural one. Pons and pump.fun each host one thumbnail per coin and
 * neither bans adult content. Hexapus hosts up to 5 packs x 200 images per coin, in a
 * downloadable zip behind a "hold the coin to unlock" gate. That is not a thumbnail, it is a
 * distribution channel, and a gated bulk download is the shape someone would abuse. Copying
 * their policy would not copy their exposure.
 *
 * ## Two models, and why
 *
 * Measured on this repo's own 27 meme images, all of which are clean:
 *
 *   MobileNetV2    78ms   max porn score **56.8%** — on a celebrity portrait
 *   InceptionV3   513ms   max porn score **1.1%**  — same image scores 0.3%
 *
 * MobileNetV2 alone is unusable here: it fires on face crops, and a meme launchpad receives
 * those constantly. InceptionV3 alone costs 51s for a 100-image pack.
 *
 * So MobileNetV2 screens and InceptionV3 judges. Only images the cheap model finds suspicious
 * get the expensive second look, and the verdict always comes from the accurate one. On this
 * sample that is ~4% of images, putting a 100-image pack near 10s instead of 51s. Most launches
 * never load InceptionV3 at all.
 *
 * The screen threshold is deliberately far below the reject threshold: anything the screen
 * misses is never looked at again, so it errs heavily toward a second opinion.
 *
 * ## What this is not
 *
 * A filter, not a guarantee. It will miss things and occasionally refuse something harmless.
 * The thresholds below were calibrated against 27 images — validate them against real material
 * before trusting them. It does nothing about CSAM specifically, which is a criminal matter
 * needing hash matching and a reporting path; see docs/PACKS.md.
 */
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

type Scores = Record<string, number>;
type Model = { classify(t: unknown): Promise<{ className: string; probability: number }[]> };

/** Anything at or above this on the screen earns a second look from the accurate model. */
const SCREEN = 0.15;

/**
 * Reject thresholds, applied to InceptionV3's scores.
 *
 * `sexy` sits far higher than the rest: it fires on swimwear and on ordinary character art, and
 * a meme launchpad would reject its own artwork at a low bar.
 */
const REJECT = { porn: 0.6, hentai: 0.6, sexy: 0.9 };

let tf: typeof import('@tensorflow/tfjs');
let screen: Model | null = null;
let judge: Model | null = null;
let booting: Promise<void> | null = null;

async function backend(): Promise<void> {
  if (tf) return;
  const req = createRequire(import.meta.url);
  tf = await import('@tensorflow/tfjs');
  const { setWasmPaths } = await import('@tensorflow/tfjs-backend-wasm');
  // WASM, not the native binding: tfjs-node is 724 MB and its build failed outright here, and
  // `npm ci` runs on every VPS deploy. WASM installs the same way everywhere.
  setWasmPaths(dirname(req.resolve('@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm')) + '/');
  await tf.setBackend('wasm');
  await tf.ready();
}

/**
 * Models load on first use, not at boot: an indexer that only follows the chain should not pay
 * for a model it never calls. Weights come from nsfwjs's CDN, so the first upload after a
 * restart needs outbound network — a failure there is not swallowed, see `check`.
 */
async function ready(): Promise<void> {
  if (screen) return;
  if (!booting) {
    booting = (async () => {
      await backend();
      const nsfw = await import('nsfwjs');
      screen = await nsfw.load();
    })().catch((e) => { booting = null; throw e; });
  }
  await booting;
}

async function verdictModel(): Promise<Model> {
  if (!judge) {
    const nsfw = await import('nsfwjs');
    judge = await nsfw.load('InceptionV3');
  }
  return judge;
}

/** Decode to the square of raw RGB the model expects. */
async function pixels(body: Buffer, size: number) {
  // Flattened onto white rather than `removeAlpha()`: a transparent sticker over black turns
  // into a silhouette, which is not what the creator uploaded or what a viewer will see.
  const { data, info } = await sharp(body, { animated: false })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(size, size, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

async function classify(model: Model, body: Buffer, size: number): Promise<Scores> {
  const { data, info } = await pixels(body, size);
  const t = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  try {
    const out = await model.classify(t as never);
    return Object.fromEntries(out.map((p) => [p.className.toLowerCase(), p.probability]));
  } finally {
    t.dispose();
  }
}

const risk = (s: Scores) => Math.max(s.porn ?? 0, s.hentai ?? 0, s.sexy ?? 0);

/**
 * Throws if any image looks explicit, or if the classifier cannot run at all.
 *
 * **Fails closed.** A check that quietly passes when the model is unavailable is not a check; it
 * would be bypassable by waiting for a CDN outage. The cost is that uploads stop when the model
 * cannot load, which is the right way round for this particular decision.
 */
export async function check(images: Buffer[]): Promise<void> {
  try {
    await ready();
  } catch (e) {
    throw new Error(`content check unavailable, upload refused: ${(e as Error).message}`);
  }

  for (const body of images) {
    const first = await classify(screen!, body, 224);
    if (risk(first) < SCREEN) continue;

    let final: Scores;
    try {
      final = await classify(await verdictModel(), body, 299);
    } catch (e) {
      throw new Error(`content check unavailable, upload refused: ${(e as Error).message}`);
    }

    const hit = (Object.keys(REJECT) as (keyof typeof REJECT)[])
      .find((k) => (final[k] ?? 0) >= REJECT[k]);
    if (hit) {
      throw new Error(
        `refused: this looks like sexual content (${hit} ${((final[hit] ?? 0) * 100).toFixed(0)}%). ` +
        'Hexapus does not host it. If this is wrong, mail contact@hexapus.trade.',
      );
    }
  }
}

/**
 * Decode the image and return its real format.
 *
 * Nothing before this point knows what a file is: `content-type` is whatever the client sent and
 * an extension is whatever it was named. This was the gap — uploads were stored on the strength
 * of a header alone.
 */
export async function verifyImage(body: Buffer, allowed: Set<string>): Promise<string> {
  let format: string | undefined;
  try {
    ({ format } = await sharp(body, { animated: false }).metadata());
  } catch {
    throw new Error('not a readable image');
  }
  const ext = format === 'jpeg' ? 'jpg' : format;
  if (!ext || !allowed.has(ext)) throw new Error(`unsupported image format ${format ?? '(unknown)'}`);
  return ext;
}
