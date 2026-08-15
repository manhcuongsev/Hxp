# Livestream — separate backend

> **DESCOPED 2026-08-12.** The Live tab was removed from Explore, so the feature has no
> discovery surface and is not being built. This document is kept because the moderation
> analysis in §1 is the part that matters if it is ever revisited — and because that section
> is the reason not to ship it casually.

Creators stream themselves by camera, or share a browser/desktop window. **Two hours
maximum per session.** Nothing about this touches the chain, so it is its own service with
its own database.

---

## 1. Read this part before the architecture

**Moderation is the hard problem here, not video delivery.**

Pump.fun shipped livestreaming, and within months was dealing with users broadcasting
self-harm threats and extreme content to pressure coin prices. They pulled the feature
entirely, then brought it back behind moderation. That is the well-documented precedent for
exactly this feature on exactly this kind of product.

A live video feed attached to a financial incentive attracts people who will do anything for
attention, because attention moves the price. That is not a hypothetical. Plan for it before
launch, not after the first incident:

- **A kill switch that works in seconds**, operable by one on-call person, that ends a
  stream and blocks the creator's wallet from starting another.
- **Viewer reporting** on every stream, one click, no account required.
- **Human review**, with someone actually reachable. Automated classifiers are a filter, not
  a decision-maker.
- **A takedown and preservation path** for law enforcement requests, written down before you
  need it.
- **Jurisdiction and terms** — you are hosting user-generated video. Get advice on what that
  makes you liable for where you operate. This is a lawyer question, not an engineering one.

If there is no appetite to staff moderation, **do not ship livestreaming**. A launchpad with
no video is a smaller product. A launchpad hosting the wrong stream is an ended one.

---

## 2. Architecture

```
creator browser
  getUserMedia (camera)  ─┐
  getDisplayMedia (screen)─┴─► WHIP ingest ──► transcode ──► LL-HLS ──► CDN ──► viewers
                                    │
                                 control plane
                                 (auth, TTL, moderation, state)
```

**Ingest: WHIP** (WebRTC-HTTP Ingestion). It is the standard for browser-to-server WebRTC,
needs no plugin, and handles camera and `getDisplayMedia` identically — the creator picks a
source and the pipeline does not care which.

**Delivery: LL-HLS behind a CDN**, not peer WebRTC. A coin that works gets thousands of
concurrent viewers, and an SFU that fans out WebRTC to thousands is real infrastructure.
LL-HLS gives 2–5s latency, which is fine — the interaction that matters is *chat and buys*,
not sub-second video.

**Build order: managed provider first.** Cloudflare Stream, Livepeer or Mux all do
WHIP-in / HLS-out. Self-hosting mediasoup or Janus for v1 is weeks of work to solve a
problem you do not yet have. Keep the ingest URL and playback URL behind your own API so
swapping providers later is a config change.

---

## 3. Who is allowed to stream

Only the **creator of that coin**, and it must be proven, not asserted:

```
1  client asks POST /live/token  { coin }
2  server issues a SIWE nonce
3  wallet signs
4  server recovers the address and checks it equals the on-chain creator
     — HexaFactory.launches[commitHash].creator, read from our own indexer
5  server returns a WHIP ingest URL with a signed, expiring credential
```

The ingest credential is **short-lived and refreshed**, so revoking a stream means refusing
the next refresh rather than chasing a long-lived secret.

## 4. The two-hour cap

Enforce **server-side**, on the control plane — never in the client, which the creator
controls.

```
session.expiresAt = startedAt + 2h        // hard stop
refresh every 5 min; refuse past expiresAt
on expiry: revoke ingest, mark ENDED, keep the coin page alive
```

A creator who wants to keep going starts a new session. That is a feature: it forces a
periodic re-auth against the current on-chain creator, and it bounds the blast radius of a
leaked credential to the remaining slice.

## 5. State the Explore → Live tab needs

```sql
CREATE TABLE streams (
  id           TEXT PRIMARY KEY,
  coin         TEXT NOT NULL,          -- token address
  creator      TEXT NOT NULL,
  status       TEXT NOT NULL,          -- LIVE | ENDED | KILLED
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  playback_url TEXT
);
CREATE INDEX idx_streams_live ON streams(status, started_at);
```

That covers both sort orders the Live tab offers — longest-running first is
`ORDER BY started_at ASC`, just-started is `DESC`.

Viewer counts come from the CDN's analytics, polled. Do not try to count viewers yourself.

## 6. Recording

**Default to not recording.** Retention of user-generated video is a liability with no
product benefit for a live-trading feature, and it multiplies the moderation problem into
the past tense.

If recording is wanted later, make it opt-in per stream, short retention, and never the
default.

## 7. Cost

Egress dominates. One coin going viral with a few thousand concurrent viewers for two hours
is a real bill, and it arrives exactly when the product is working. Set a per-stream and a
per-day spend cap in the provider before opening this to the public, or a single stream can
outspend a month of everything else.
