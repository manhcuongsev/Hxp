# Asset packs — Bundle launches

A meme that ships with nothing is a ticker. A meme that ships with stickers, icons and
sprite sheets is something a community can actually take over and keep posting with.

A **Bundle** launch attaches one or more downloadable asset packs to a launch. The packs are the hook that
makes buying feel like getting something, and the raw material a CTO needs later.

**The packs are marketing, not merchandise.** Nobody is being charged for them, and the design
below does not try to stop them spreading. A watermark here is an attribution mark, not DRM —
see §5.

---

## 1. Two launch modes

| | **Coin** | **Bundle** |
|---|---|---|
| Name, ticker, artwork | required | required |
| Story (`description`) | optional | **required** |
| Packs | none | 1–5, each with its own description |

Coin is exactly what exists today; nothing about it changes. Bundle is a superset, chosen by
a toggle at the top of `create.html`.

The story is already collected, already goes on-chain, and is already served by the indexer —
it is only missing from `coin.html`. Rendering it is a prerequisite for Bundle and worth
shipping on its own before any of this.

---

## 2. What is on-chain and what is not

The story is on-chain and **immutable**, by decision. It lives in the base64 metadata URI baked
at reveal, and `decodeMetadata` caps it at 500 characters.

Packs cannot go on-chain — the images are megabytes and Arc is not a storage chain. They live
on the indexer host, in its database and on its disk.

That split leaves a hole worth closing. If the packs live entirely off-chain, then **the pack is
not part of what the buyer provably bought**: the creator can swap or delete files after launch
and the coin still claims to have them. For a product whose whole pitch is "the meme comes with
something", that is the one dishonest edge.

### The manifest hash closes it

`/upload` is already content-addressed — the stored filename is `sha256(bytes)`. So every asset
already has a hash, and committing the whole set costs one extra field:

```jsonc
// the metadata JSON that is base64'd into the on-chain URI
{
  "description": "…the story…",
  "image": "https://…",
  "packs": "sha256:9f2c…"      // ← new: hash of the manifest below
}
```

The manifest itself is a JSON file stored next to the assets:

```jsonc
{
  "packs": [
    {
      "name": "Sticker pack",
      "description": "12 Telegram stickers, 512×512, transparent.",
      "gate": "holder",
      "assets": ["a1b2…40hex.png", "c3d4…40hex.png"],
      "preview": { "kind": "auto" }
    }
  ]
}
```

Because the manifest names assets by content hash and the manifest itself is hashed into the
on-chain metadata, **the entire pack contents are committed at launch**. The coin page can then
verify and show `packs verified` or `packs changed since launch` — the same posture the rest of
the product takes: do not prevent, but record and display.

Cost: one string in a JSON blob that is already being written. There is no reason not to.

### Sequencing

The hash must exist before the metadata is built, so uploads happen **before commit**:

```
upload assets → server returns manifest hash → commit(hash inside metadata) → wait 12 blocks → reveal
```

This is the same order artwork already follows. The 12-block wait is about 6 seconds and is not
a window for uploading anything.

---

## 3. Gating

Unlock is **holding any non-zero balance of the coin**. There is no threshold to configure.

Every threshold field is a number the creator will set wrong, and one set too high turns the
hook into a wall. The point of Bundle is to convert someone into a buyer, not to extract from
someone who already is.

Per pack the creator picks one of three gates:

| `gate` | Who can download |
|---|---|
| `public` | anyone, no wallet |
| `holder` | any holder — **default** |
| `graduated` | everyone, but only after the coin graduates |

`graduated` is what makes multiple packs worth having rather than being folders: early buyers get
a window of exclusivity, graduation gets a payoff beyond "now it is on Uniswap", and the material
becomes unrestricted exactly when a community takeover would need it.

### How eligibility is checked

No contract change.

```
client: sign "Hexapus pack download / token / pack / at:<ts>"
        → POST /packs/:token/download
server: recover the address, read balanceOf on Arc, stream the zip
```

**Against the chain's `balanceOf`, not against holdings rebuilt from indexed trades** — corrected
during the build. A wallet that received the coin as a plain ERC-20 transfer never appears in the
trade history, and would be told it does not hold what it is holding.

The message names the token and the pack index, so a signature for a public pack cannot be
replayed against a gated one, and the timestamp expires it after five minutes. It is deliberately
not hardened further: once one holder has the zip, the zip is out, which is the intended outcome.

---

## 4. Storage

Gated assets **must not** go in `MEDIA_DIR`. `/media` is `express.static` with no auth, and the
filenames are content hashes, so anything placed there is public to anyone who learns the hash.

```
<stateDir>/media/                 public — coin artwork, creator previews  (served statically)
<stateDir>/packs/assets/          gated  — every pack asset, by content hash
<stateDir>/packs/<manifestHash>/  manifest.json, generated previews, REMOVED marker
```

**Keyed by manifest hash, not by token** — corrected during the build. Uploads happen before
commit, so the token address does not exist yet; the hash is the only name available when the
bytes arrive. The token is linked to it later through the on-chain metadata.

Downloads are zipped on demand. Storing a pre-built zip would double the disk for no gain.

Four routes, all on the indexer: `POST /packs/asset`, `POST /packs/manifest`,
`GET /packs/:token`, `POST /packs/:token/download`, plus `GET /packs/:hash/preview/:index` for
the generated sheets. Unlock and download are deliberately one call — issuing a signed URL first
would add an expiry scheme to protect a file that is meant to spread.

### Limits

Images only. **No `.zip` uploads and no executables** — a sticker or sprite sheet is a PNG, and
refusing everything else removes the entire malware class rather than trying to scan for it. The
existing `MEDIA_TYPES` allowlist is the right shape; packs use a narrower version of it with the
video type dropped.

The type is verified by decoding the image, not by trusting `content-type` or the extension.

**One budget, not three competing caps.** The creator gets a byte allowance for the whole coin
and spends it however suits — twenty small stickers or five large sprite sheets — and the form
shows what is left while they pick, rather than refusing at submit after they chose twenty files.

| | Limit | What it is |
|---|---|---|
| Bytes per coin | **50 MB** | the budget, and the only one that costs anything |
| Bytes per asset | 10 MB | a guard, so one file cannot eat the allowance |
| Assets per pack | 20 | a UI bound |
| Packs per coin | 5 | more is a file browser, not a pack |

`bytesPerCoin` is the disk bill: **50 MB × 1,000 coins = 50 GB**. It is one constant in
`indexer/packs.ts` (mirrored in `create.html`) and it is the knob to turn if that is too much.
The VPS was sized for "indexers + site only", so this needs a disk check before Bundle opens to
the public.

---

## 5. Previews

Two kinds, per pack:

**`auto`** — the server composites a contact sheet from the pack's assets: a grid, downscaled to
1200 px wide, with a small `hexapus.trade` mark in a corner.

**`creator`** — the creator uploads their own preview image. It goes to `/media` like any other
public artwork and gets the same corner mark.

### The watermark is not protection

A watermarked preview of pixel art is trivially cropped, and none of that matters here — the
packs are meant to spread. What the mark is for is that **when a preview gets reposted, it
carries where it came from.**

That flips the design: the mark should be small, in a corner, legible, and leave the preview
worth sharing. A large diagonal `PREVIEW` stamp would protect nothing and stop the image doing
the one job it has.

`auto` is composited with `sharp` (now a dependency) and cached to disk on first request: a grid
of up to 4 columns, dark ground, generated once and served immutable thereafter. It is a **native
module**, so a VPS deploy must run `npm ci` rather than copying `node_modules`.

---

## 6. Moderation and takedown

Hosting images that other people download raises the same class of problem that got livestreaming
descoped (`LIVE.md` §1). It is smaller here — images only, no live feed — but not zero:

- Stolen artwork, with the DMCA notice arriving at whoever hosts it
- The same exposure that already exists for coin artwork, now at 100× the file count

What is needed before this is public:

- A takedown path that sets a pack to `removed` and keeps saying so. The manifest hash is
  on-chain and permanent; a pack that quietly 404s makes the coin look broken, while
  `removed after a copyright complaint` is honest and matches the hash still being there.
- An operator route to do it in seconds, without a deploy.

---

## 7. Not in v1

- **No per-pack pricing or burn-to-unlock.** Bundle is a hook; charging for the pack is a
  different product and would need the gate to actually hold, which for a downloaded file it
  never can.
- **No editing packs after launch.** The hash is committed. Re-uploading is possible but the coin
  page will say the packs changed, which is the intended trade.
- **No pack storage beyond this machine.** Same honest limitation the media store already carries:
  outliving the operator needs IPFS, which is a decision about who pays for pinning.

## 8. Open — needs a decision before build

1. **Explore has to show which coins are Bundle**, or the mode is invisible and creates no pull.
   A badge on the card, a filter, or its own tab — not yet decided.
2. **Creator fees after a CTO.** Unrelated to packs but on the same thesis: the creator's 40–50%
   fee share keeps flowing to a wallet that abandoned the coin, while the community carries it.
   That, not the packs, is what decides whether a takeover is real.
