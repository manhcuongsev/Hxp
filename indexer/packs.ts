/**
 * Asset packs — the downloadable half of a mode 2 launch. See `docs/PACKS.md`.
 *
 * Three things shape everything here:
 *
 * 1. **Content addressing all the way down.** Assets are stored under `sha256(bytes)`, the
 *    manifest names them by that hash, and the manifest's own hash is what goes into the coin's
 *    on-chain metadata. So the pack contents are committed at launch and a later swap is visible
 *    rather than silent.
 *
 * 2. **No database table.** The token -> manifest link already exists on-chain in
 *    `metadata_uri`, so adding a table would mean storing the same fact twice and choosing which
 *    copy to believe when they disagree.
 *
 * 3. **Keyed by manifest hash, not by token.** `docs/PACKS.md` says `packs/<token>/`, which
 *    cannot work: uploads happen before commit, and the token address does not exist until
 *    reveal. The hash is the only name available at the time the bytes arrive.
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { check, verifyImage } from './moderate.js';

export const PACK_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

/**
 * One budget, not three competing numbers.
 *
 * `bytesPerCoin` is the real constraint and the only one that costs anything — it is what
 * multiplies by the number of coins to give the disk bill (50 MB x 1,000 coins = 50 GB). The
 * creator spends it however they like: twenty small stickers or five large sprite sheets.
 *
 * `bytesPerAsset` is not a second budget, it is a guard — one file must not be able to eat the
 * whole allowance, and sharp has to decode whatever arrives to build the preview.
 * `assetsPerPack` is a sanity bound, not a storage one — a 100-image sprite set is a normal
 * pack, and the byte budget is what actually stops it getting out of hand.
 *
 * These are mirrored in create.html. A browser check only saves the upload; this is the copy
 * that enforces.
 */
export const LIMITS = {
  packs: 5,
  assetsPerPack: 200,
  bytesPerAsset: 10 * 1024 * 1024,
  bytesPerCoin: 50 * 1024 * 1024,
  name: 60,
  description: 300,
};

const GATES = new Set(['public', 'holder', 'graduated']);

export type Pack = {
  name: string;
  description: string;
  gate: 'public' | 'holder' | 'graduated';
  assets: string[];
  preview: { kind: 'auto' } | { kind: 'creator'; url: string };
};
export type Manifest = { packs: Pack[] };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function packStore(stateDir: string) {
  const root = join(stateDir, 'packs');
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });

  const assetPath = (file: string) => join(assets, file);
  const manifestDir = (hash: string) => join(root, hash);

  /** Reject anything that could escape the assets directory before it reaches the filesystem. */
  const isAssetName = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{40}\.(png|jpg|webp|gif)$/.test(v);

  const str = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s.length > 0 && s.length <= max ? s : null;
  };

  return {
    root,

    /**
     * Store one image. Returns the name the manifest will refer to it by.
     *
     * The extension comes from decoding the file, not from `content-type` — that header is
     * whatever the client typed, and it was the only thing being checked here.
     */
    async putAsset(body: Buffer, contentType: string) {
      if (!PACK_TYPES[contentType]) throw new Error(`unsupported type ${contentType || '(none)'}`);
      if (body.length === 0) throw new Error('empty body');
      if (body.length > LIMITS.bytesPerAsset) {
        throw new Error(`over ${LIMITS.bytesPerAsset / 1048576} MB`);
      }
      const ext = await verifyImage(body, new Set(Object.values(PACK_TYPES)));
      const name = `${sha(body).slice(0, 40)}.${ext}`;
      // Content-addressed, so an identical re-upload is already on disk and rewriting it would
      // only risk truncating a file another manifest is pointing at.
      if (!existsSync(assetPath(name))) writeFileSync(assetPath(name), body);
      return { asset: name, bytes: body.length };
    },

    /**
     * Validate and store a manifest, returning the hash that belongs in the on-chain metadata.
     *
     * The stored bytes are the canonical form this function produced, never the caller's — so
     * re-reading and re-hashing the file reproduces the same hash, which is what makes the
     * on-chain commitment checkable later.
     */
    async putManifest(input: unknown) {
      const raw = (input as Manifest)?.packs;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.packs) {
        throw new Error(`packs must be an array of 1 to ${LIMITS.packs}`);
      }

      let total = 0;
      const packs: Pack[] = raw.map((p, i) => {
        const where = `pack ${i + 1}`;
        const name = str((p as Pack)?.name, LIMITS.name);
        const description = str((p as Pack)?.description, LIMITS.description);
        if (!name) throw new Error(`${where}: name is required, max ${LIMITS.name} chars`);
        if (!description) throw new Error(`${where}: description is required, max ${LIMITS.description} chars`);

        const gate = (p as Pack)?.gate ?? 'holder';
        if (!GATES.has(gate)) throw new Error(`${where}: gate must be one of ${[...GATES].join(', ')}`);

        const list = (p as Pack)?.assets;
        if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.assetsPerPack) {
          throw new Error(`${where}: 1 to ${LIMITS.assetsPerPack} assets`);
        }
        for (const a of list) {
          if (!isAssetName(a)) throw new Error(`${where}: bad asset name`);
          if (!existsSync(assetPath(a))) throw new Error(`${where}: asset ${a} was never uploaded`);
          total += statSync(assetPath(a)).size;
        }

        const pv = (p as Pack)?.preview;
        let preview: Pack['preview'];
        if (pv?.kind === 'creator') {
          const url = typeof pv.url === 'string' ? pv.url : '';
          // Public artwork only. A preview is shown before anyone holds the coin, so pointing it
          // at a gated asset would publish the very thing the gate is there for.
          if (!/^\/media\/[0-9a-f]{40}\.(png|jpg|webp|gif|mp4)$/.test(url)) {
            throw new Error(`${where}: creator preview must be an uploaded /media file`);
          }
          preview = { kind: 'creator', url };
        } else {
          preview = { kind: 'auto' };
        }

        // Keys written in a fixed order: the hash has to be reproducible, and object key order
        // is whatever the caller's JSON happened to use.
        return { name, description, gate, assets: [...list], preview };
      });

      if (total > LIMITS.bytesPerCoin) {
        throw new Error(`packs total ${(total / 1048576).toFixed(1)} MB, over the ${LIMITS.bytesPerCoin / 1048576} MB limit`);
      }

      // Run at manifest time rather than per upload: this is the moment the whole set for one
      // coin is known, it happens once, and 2.5s for a hundred images is a cost a launch can
      // carry where a hundred separate upload requests could not.
      await check(packs.flatMap((p) => p.assets).map((a) => readFileSync(assetPath(a))));

      const bytes = Buffer.from(JSON.stringify({ packs }), 'utf8');
      const hash = sha(bytes);
      const dir = manifestDir(hash);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), bytes);
      return { hash, packs: packs.length, bytes: total };
    },

    /** null when the hash names nothing here — an unknown hash is not an error, just absent. */
    readManifest(hash: string): Manifest | null {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const file = join(manifestDir(hash), 'manifest.json');
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      } catch {
        return null;
      }
    },

    /**
     * Taken down after a complaint. Kept as a marker rather than a deletion: the manifest hash is
     * on-chain and permanent, so a pack that simply 404s makes the coin look broken, while
     * "removed" is the honest answer and matches the hash still being there.
     */
    removal(hash: string): string | null {
      const f = join(manifestDir(hash), 'REMOVED');
      return existsSync(f) ? readFileSync(f, 'utf8').trim() || 'removed' : null;
    },
    remove(hash: string, reason: string) {
      const dir = manifestDir(hash);
      if (!existsSync(dir)) throw new Error('unknown manifest');
      writeFileSync(join(dir, 'REMOVED'), reason);
    },

    /**
     * A contact sheet of one pack, generated once and cached.
     *
     * Public on purpose, even though it is built from gated assets: a preview exists to be seen
     * before anyone holds the coin, and a downscaled grid is not a substitute for the pack.
     *
     * The mark in the corner is attribution, not protection. A watermark over pixel art is
     * cropped in seconds, and packs are meant to spread anyway — what matters is that a reposted
     * preview still says where it came from. So it stays small and leaves the image worth sharing.
     */
    async preview(hash: string, index: number): Promise<Buffer | null> {
      const m = this.readManifest(hash);
      const pack = m?.packs[index];
      if (!pack) return null;

      const cached = join(manifestDir(hash), `preview-${index}.png`);
      if (existsSync(cached)) return readFileSync(cached);

      // A sample, not the whole pack. At four columns a 100-image set would composite into a
      // 30,000px tall PNG that nobody can look at and every viewer has to download.
      const SHOWN = 12;
      const shown = pack.assets.slice(0, SHOWN);

      const W = 1200;
      const cols = Math.min(4, shown.length);
      const cell = Math.floor(W / cols);
      const rows = Math.ceil(shown.length / cols);
      const H = cell * rows;
      const pad = Math.round(cell * 0.08);

      const tiles = await Promise.all(shown.map(async (a, i) => ({
        input: await sharp(assetPath(a), { animated: false })
          .resize(cell - pad * 2, cell - pad * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png().toBuffer(),
        left: (i % cols) * cell + pad,
        top: Math.floor(i / cols) * cell + pad,
      })));

      const more = pack.assets.length - shown.length;
      const mark = Buffer.from(
        `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
           ${more > 0 ? `<text x="18" y="${H - 16}" font-family="sans-serif" font-size="19"
                 fill="#ffffff" fill-opacity="0.5">+${more} more</text>` : ''}
           <text x="${W - 18}" y="${H - 16}" text-anchor="end" font-family="sans-serif"
                 font-size="19" fill="#ffffff" fill-opacity="0.5">hexapus.trade</text>
         </svg>`);

      const out = await sharp({
        create: { width: W, height: H, channels: 4, background: { r: 18, g: 20, b: 26, alpha: 1 } },
      }).composite([...tiles, { input: mark, left: 0, top: 0 }]).png().toBuffer();

      writeFileSync(cached, out);
      return out;
    },

    /** A zip of one pack's assets, built on demand — a stored zip would double the disk. */
    zip(hash: string, index: number): Buffer | null {
      const m = this.readManifest(hash);
      const pack = m?.packs[index];
      if (!pack) return null;
      const files = pack.assets.map((a, i) => {
        // Numbered in manifest order: a content hash is a correct name and a useless one.
        const ext = a.split('.').pop()!;
        return { name: `${String(i + 1).padStart(2, '0')}.${ext}`, body: readFileSync(assetPath(a)) };
      });
      return storeZip(files);
    },
  };
}

/**
 * A store-only (uncompressed) zip.
 *
 * Deflate is skipped on purpose rather than for simplicity: PNG, GIF and WebP are already
 * compressed, so it would spend CPU per download to save almost nothing. Store-only also keeps
 * this to one pass with no stream plumbing.
 */
export function storeZip(files: { name: string; body: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const sum = crc32(f.body);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0, 6);            // flags
    lh.writeUInt16LE(0, 8);            // method 0 = store
    lh.writeUInt16LE(0, 10);           // mod time — fixed, so the same pack zips to the same bytes
    lh.writeUInt16LE(0x21, 12);        // mod date: 1980-01-01, the zip epoch
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(f.body.length, 18);
    lh.writeUInt32LE(f.body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);           // extra field length
    local.push(lh, name, f.body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(f.body.length, 20);
    ch.writeUInt32LE(f.body.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk number
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // offset of the local header
    central.push(ch, name);

    offset += lh.length + name.length + f.body.length;
  }

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);    // end of central directory
  end.writeUInt16LE(0, 4);             // this disk
  end.writeUInt16LE(0, 6);             // disk with the central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...local, cd, end]);
}
