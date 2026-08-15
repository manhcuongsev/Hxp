# Production topology

What runs on localhost today is the development shape of this. Nothing about the design
changes when it moves to a VPS — the pieces are already split the right way.

---

## 1. The problem to actually solve is the RPC, not the data layer

Every 429 in this project traces to one thing: **`rpc.testnet.arc.network` is a shared public
endpoint that rate-limits by IP.** The indexer hit it. The browser hit it. Both were fixed by
sending fewer requests, which is mitigation, not a solution.

On a VPS the real fix is available:

| Option | What it costs | What it gives |
|---|---|---|
| **Run an Arc node** ([docs](https://docs.arc.io/arc/tutorials/run-an-arc-node.md)) | a machine | no rate limit, own WS subscriptions, full history |
| **Paid RPC provider** | a subscription | no practical rate limit, no ops |
| Public endpoint | free | what we have been fighting all week |

Everything below assumes one of the first two. With them, the throttling and backoff code
stays as a safety net but stops being load-bearing.

---

## 2. Topology

```
                        ┌──────────────── VPS ────────────────┐
  browser ──── https ──►│  caddy / nginx                       │
                        │    /            → site/ (static)     │
                        │    /api/hexa    → :8880  indexer     │
                        │    /api/network → :8881  indexer     │
                        │    /ws          → push updates       │
                        │                                      │
                        │  indexer:hexa     factory + curves   │
                        │  indexer:network  full-chain scan    │
                        │  arc node (or paid RPC)              │
                        └──────────────────────────────────────┘
```

**Two indexer processes, as they already are.** They are split because their load profiles are
nothing alike: `hexa` watches one address over a WebSocket and is nearly free; `network` scans
every `Transfer` on the chain and is not. One should never be able to starve the other.

**Same origin.** With the site and the API behind one hostname, the CORS header goes away,
`localStorage.hexaApi` goes away, and the browser only ever talks to your server.

**The browser never reads the chain for display data.** It already does not, after the
`/curve` proxy. It uses the RPC for exactly two things, both of which have to be live:
quoting a trade, and sending one through the wallet.

---

## 3. Where Circle webhooks fit — and where they do not

Webhooks are a fine notification channel and a bad source of truth. That has not changed:

- Deliveries can be **missed, duplicated, or reordered**.
- An endpoint down for five minutes loses those events permanently unless something backfills
  them — and that something *is* an indexer.
- **Not every interaction comes through your frontend.** Bots call the contract directly. That
  is the entire premise of the anti-snipe work. A data layer fed only by your own UI would be
  wrong precisely for the coins that matter most.

More to the point: **once you run your own node, webhooks add nothing.** A WebSocket
subscription gives the same latency, from the chain itself, with no third party in the path
and no delivery guarantees to reason about.

Keep webhooks for what they are good at — telling a *user* something happened ("your coin
graduated") — which is a different job from knowing what is true.

---

## 4. What still needs building

**Push, not poll.** The browser currently polls `/curve` every 15 seconds and Explore every 20.
That is fine for one user and wasteful at scale: idle tabs cost the same as busy ones, and
updates are up to 15 seconds stale. Production wants a WebSocket from the indexer to the
browser, pushing on the events it already receives. The indexer is subscribed to the chain
already; it just does not forward.

**A real database.** SQLite is correct for one process on one box. Two indexers plus an API
plus WebSocket fan-out eventually wants Postgres — but not before it hurts, and it does not
hurt yet.

---

## 5. How comparable sites do it

Every serious launchpad or chart site converges on the same shape:

1. **Dedicated RPC** — their own nodes, or a provider tier well past the free plan. Nobody
   serving real traffic reads from a shared public endpoint.
2. **A backend indexer** writing to their own database, which is the only thing the frontend
   queries for display data.
3. **WebSocket push** to the browser for live prices and new launches, rather than polling.
4. **CDN** in front of the static assets.
5. **The wallet is the only thing in the browser that touches the chain**, and only to sign.

The pattern we started with — browser reads contracts directly over a public RPC — is a
prototype pattern. It works until roughly the second tab, which is exactly what happened.
