# VPS spec and running your own Arc RPC

Goal: stop depending on `rpc.testnet.arc.network`. Every 429 in this project came from that
one shared endpoint, and no amount of client-side batching fixes a shared quota.

Node facts below are from Arc's own docs for **v0.7.3**. Two of them change decisions in this
project, so read §5 before provisioning anything.

---

## 1. What you are actually running

```
┌──────────────────────────── VPS ────────────────────────────┐
│  caddy               :443   TLS, static site, /api proxy     │
│  indexer:hexa        :8880  factory + curves, WS feed        │
│  indexer:network     :8881  full-chain ERC-20 scan           │
│  arc-node-execution  :8545 http  :8546 ws  :9001 metrics     │
│  arc-node-consensus  :31000 rpc  :29000 metrics              │
└──────────────────────────────────────────────────────────────┘
```

An Arc node is **two processes**. The Execution Layer (EL, reth-based) executes transactions
and serves JSON-RPC. The Consensus Layer (CL) pulls finalized blocks from **relay endpoints**,
verifies their signatures and feeds them to the EL. There is no P2P gossip — `--disable-discovery`
is mandatory, which is why the CL needs `--follow.endpoint` URLs instead of peers.

**Running a follower node is permissionless.** Arc's *validator* set is permissioned regulated
institutions; nothing in the node docs gates running a node that syncs and serves RPC. That is
the one that matters here.

## 2. Sizing

| | Indexers + site only | With an Arc node |
|---|---|---|
| vCPU | 2 | 8 |
| RAM | 4 GB | 32 GB |
| Disk | 20 GB SSD | **≥ 300 GB NVMe** |
| Network | 1 TB/mo | 10 TB/mo |

The disk number is driven by a documented fact, not a guess: testnet snapshots are
**68 GB EL + 16 GB CL compressed**, extracting to roughly **103 GB and 36 GB**. Arc's docs ask
for at least 150 GB free *for the restore alone*. Add the chain's ongoing growth — 56.5M blocks
at a measured 1.92 blocks/second and ~21 `Transfer` logs per block — and 300 GB on a volume you
can expand is the honest starting point.

Confirm CPU and RAM against
[node requirements](https://docs.arc.io/arc/references/node-requirements) before you pay for
anything; that page is the authority and it moves with releases.

**If you would rather not run a node**, a paid RPC subscription removes the rate limit for a
fraction of the operational cost. Point `ARC_RPC_URL` at it and skip to §6.

## 3. Base setup

```bash
adduser --disabled-password arc && usermod -aG sudo arc
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs git
```

**Nothing but 80/443 is exposed.** 8545, 8546, 8880, 8881, 8551 and the metrics ports all bind
to localhost and are reached through the proxy. An open RPC port is found by scanners within
hours, and `--authrpc` in particular controls block production.

## 4. Install and run the node

Fastest path — pre-built binaries, no Rust toolchain:

```bash
export ARC_HOME="${ARC_HOME:-$HOME/.arc}"
curl -L https://raw.githubusercontent.com/circlefin/arc-node/main/arcup/install | bash
source "$ARC_HOME/env"
```

Docker and source builds are both supported; see
[Run an Arc node](https://docs.arc.io/arc/tutorials/run-an-arc-node). Docker is the least
fiddly if you already run it — its init containers handle the snapshot and CL key for you.

```bash
cat << "EOF" > ~/.arc_env
ARC_HOME="${ARC_HOME:-$HOME/.arc}"
ARC_RUN="/run/arc"
ARC_EXECUTION=$ARC_HOME/execution
ARC_CONSENSUS=$ARC_HOME/consensus
EOF
source ~/.arc_env

mkdir -p "$ARC_EXECUTION" "$ARC_CONSENSUS"
sudo install -d -o $USER "$ARC_RUN"

arc-snapshots download --chain=arc-testnet \
  --execution-path "$ARC_EXECUTION" --consensus-path "$ARC_CONSENSUS"

arc-node-consensus init --home "$ARC_CONSENSUS"
```

The snapshot download **goes silent during extraction** — that is expected, not a hang. Budget
10–15 minutes on 100 Mbps, hours on anything slower.

> `$ARC_CONSENSUS` holds the CL private key that `init` writes. It is your node's network
> identity and cannot be recovered. Clearing that directory means re-running `init`.

### Execution layer

```bash
arc-node-execution node \
  --chain arc-testnet \
  --datadir "$ARC_EXECUTION" \
  --full \
  --disable-discovery \
  --ipcpath "$ARC_RUN/reth.ipc" \
  --auth-ipc --auth-ipc.path "$ARC_RUN/auth.ipc" \
  --http --http.addr 127.0.0.1 --http.port 8545 --http.api eth,net,web3,rpc \
  --ws   --ws.addr 127.0.0.1   --ws.port 8546   --ws.api eth,net,web3 \
  --public-api \
  --metrics 127.0.0.1:9001 \
  --enable-arc-rpc \
  --rpc.forwarder https://rpc.testnet.arc.io/
```

Three deviations from the sample in Arc's docs, each deliberate:

- **`--ws` is added.** The docs' sample command does not enable WebSocket, but the indexer's
  `hexa` role subscribes over `eth_subscribe` — without this, `ARC_WS_URL` has nothing to
  connect to. The `--ws.api` flag is documented in the `--public-api` row, so it exists.
- **`--http.api` is trimmed** from `eth,net,web3,txpool,trace,debug` to `eth,net,web3,rpc`.
  `--public-api` warns about anything beyond that set, and this project uses none of it.
- **`--full` is required on the first start** from a pruned snapshot; it reconciles database
  tables that would otherwise fail a consistency check. See §5 before dropping it later.

Defaults worth knowing on a public endpoint: `--rpc.max-connections` is **250** and
`--rpc.max-subscriptions-per-connection` is **32** (both lowered in v0.7.1 to bound WebSocket
log-fanout memory). Raise them only if clients actually report `MaxConnections` or
`TooManySubscriptions` — they are not a performance dial.

### Consensus layer

```bash
arc-node-consensus start \
  --home "$ARC_CONSENSUS" \
  --full \
  --eth-socket "$ARC_RUN/reth.ipc" \
  --execution-socket "$ARC_RUN/auth.ipc" \
  --rpc.addr 127.0.0.1:31000 \
  --follow \
  --follow.endpoint https://rpc.testnet.arc.io,wss=rpc.testnet.arc.io \
  --follow.endpoint https://rpc.drpc.testnet.arc.io,wss=rpc.drpc.testnet.arc.io \
  --follow.endpoint https://rpc.blockdaemon.testnet.arc.io,wss=rpc.blockdaemon.testnet.arc.io/websocket \
  --execution-persistence-backpressure \
  --execution-persistence-backpressure-threshold=16 \
  --metrics 127.0.0.1:29000
```

Give it all three relay endpoints. They are the only way blocks reach your node, so a single
endpoint is a single point of failure.

**Start the EL first.** The CL connects through the IPC sockets the EL creates; launched in the
wrong order it simply fails to attach and needs restarting.

### Verify

```bash
curl -s -X POST http://localhost:8545 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

The hex result should climb each time you run it. If it sits at `0x0`, the usual causes are the
IPC sockets never appearing (EL failed to start), the CL started before the EL, or an
interrupted snapshot extraction.

## 5. Two node facts that change this project

**① The snapshot is pruned, and `--full` prunes.** `scripts/findDeployBlock.mjs` binary-searches
`getBytecode` at historical block heights, and the `/curve` proxy reads current state only. The
historical search worked against the public endpoint; against a pruned node it may not, because
the state at those blocks is gone. If you need it, either keep the public endpoint as a fallback
for that one script, or run without `--full` after the first start and accept the disk cost.
Nothing else in the project reads historical state.

**② Hardforks are hard deadlines.** Arc has shipped forks that stop older nodes from syncing at
a fixed timestamp — v0.7.1 for Zero5/Zero6, v0.7.2 for Zero7. A node left un-upgraded does not
degrade, it **stops**, and your site goes stale with no error anywhere in this codebase to
explain it. Watch
[CHANGELOG.md](https://github.com/circlefin/arc-node/blob/main/CHANGELOG.md) and run `arcup`
before each activation. This is the single most likely way a working deployment breaks.

## 6. Services

```ini
# /etc/systemd/system/hexa-indexer@.service
[Unit]
Description=Hexapus indexer (%i)
After=network-online.target

[Service]
User=hexa
WorkingDirectory=/home/hexa/hexa
EnvironmentFile=/home/hexa/hexa/.env
Environment=INDEXER_ROLE=%i
ExecStart=/usr/bin/npx tsx indexer/node.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now hexa-indexer@hexa hexa-indexer@network
```

Arc publishes a
[systemd guide for the node itself](https://docs.arc.io/arc/tutorials/deploy-node-as-service);
its unit uses `RuntimeDirectory=arc`, which creates `/run/arc` for you.

`Restart=always` matters more than it looks. The indexer logs a heartbeat and handles unhandled
rejections and signals specifically so a restart loop is diagnosable rather than silent.

Point the project at the local node:

```bash
ARC_RPC_URL=http://127.0.0.1:8545
ARC_WS_URL=ws://127.0.0.1:8546
```

The throttling and backoff code stays as a safety net but stops being load-bearing.

## 7. Reverse proxy

```
hexapus.trade {
    root * /home/hexa/hexa/site
    file_server

    handle /api/hexa/*    { uri strip_prefix /api/hexa;    reverse_proxy 127.0.0.1:8880 }
    handle /api/network/* { uri strip_prefix /api/network; reverse_proxy 127.0.0.1:8881 }
}
```

Same origin removes three things at once: the CORS header, the `localStorage.hexaApi`
override, and any possibility of the browser reaching the chain directly.

## 8. Monitoring

Both node layers expose Prometheus metrics — EL at `:9001` (root path, not `/metrics`) and CL at
`:29000/metrics` — and Arc ships
[pre-built Grafana dashboards](https://docs.arc.io/arc/tutorials/set-up-node-monitoring).

The one alert worth having on day one is **block height not advancing**. It catches a stalled
CL, an exhausted relay endpoint, and a missed hardfork, all of which look identical from the
site: stale data, no errors.

## 9. Deploy

```bash
git pull && npm ci
node contracts/compile.mjs && node scripts/build-site.mjs
systemctl restart hexa-indexer@hexa hexa-indexer@network
```

`build-site.mjs` copies the ABIs and deployed addresses into `site/assets/`. Skipping it after a
contract change ships a frontend encoding calls against contracts that no longer exist — which
surfaces as unexplained reverts, not as a build error.

## 10. Before you call it production

- **Back up `data-*/`.** SQLite with WAL: `sqlite3 hexa.db ".backup out.db"`, never `cp`.
- **A stale `HEXA_FACTORY_ADDRESS` in `.env` silently pins the indexer to an old factory.** The
  startup log warns when it disagrees with `deployments/<chainId>.json`. Read that line.
- **Switching factories needs a fresh `HEXA_STATE_DIR`.** The old database describes the old
  factory and will serve its coins as though they were current.
- **Push, not poll.** The browser polls `/curve` every 15s and Explore every 20s. The indexer is
  already subscribed to the chain; it just does not forward yet. See [DEPLOY.md](DEPLOY.md).
- **Nothing here is audited**, and the contracts hold real funds on mainnet.
