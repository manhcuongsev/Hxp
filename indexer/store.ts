import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type TokenRow = {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  total_supply: string | null;
  source: string;
  first_block: number;
  transfers: number;
};

export function openStore(stateDir: string) {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'hexa.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cursor (
      role       TEXT PRIMARY KEY,
      last_block INTEGER NOT NULL
    );

    -- Every ERC-20 seen on Arc. 'source' is which venue launched it, when known.
    CREATE TABLE IF NOT EXISTS tokens (
      address      TEXT PRIMARY KEY,
      name         TEXT,
      symbol       TEXT,
      decimals     INTEGER,
      total_supply TEXT,
      source       TEXT NOT NULL DEFAULT 'unknown',
      first_block  INTEGER NOT NULL,
      transfers    INTEGER NOT NULL DEFAULT 0,
      enriched     INTEGER NOT NULL DEFAULT 0
    );

    -- Hexapus launches, from the factory only.
    CREATE TABLE IF NOT EXISTS launches (
      commit_hash  TEXT PRIMARY KEY,
      token        TEXT,
      curve        TEXT,
      creator      TEXT,
      name         TEXT,
      symbol       TEXT,
      metadata_uri TEXT,
      phase        TEXT NOT NULL,
      commit_block INTEGER,
      reveal_block INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_launch_token ON launches(token);

    -- Idempotent by (tx, log_index): re-scanning a range never double-counts, which is what
    -- lets the WebSocket feed and the reconciliation pass write the same events safely.
    CREATE TABLE IF NOT EXISTS trades (
      tx         TEXT NOT NULL,
      log_index  INTEGER NOT NULL,
      token      TEXT NOT NULL,
      side       TEXT NOT NULL,
      trader     TEXT NOT NULL,
      native_amt TEXT NOT NULL,
      token_amt  TEXT NOT NULL,
      block      INTEGER NOT NULL,
      PRIMARY KEY (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_trade_token ON trades(token, block);
    CREATE INDEX IF NOT EXISTS idx_trade_block ON trades(block);

    -- Single-tier, first-touch referral attribution, mirroring HexaCurve.referrerOf.
    CREATE TABLE IF NOT EXISTS referrals (
      token    TEXT NOT NULL,
      trader   TEXT NOT NULL,
      referrer TEXT NOT NULL,
      block    INTEGER NOT NULL,
      PRIMARY KEY (token, trader)
    );
    CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer);
  `);

  const q = {
    getCursor: db.prepare('SELECT last_block FROM cursor WHERE role = ?'),
    setCursor: db.prepare(
      'INSERT INTO cursor(role,last_block) VALUES(?,?) ON CONFLICT(role) DO UPDATE SET last_block=excluded.last_block',
    ),
    seenToken: db.prepare(`
      INSERT INTO tokens(address, first_block, transfers, source) VALUES(?,?,1,?)
      ON CONFLICT(address) DO UPDATE SET transfers = transfers + 1`),
    enrich: db.prepare(
      'UPDATE tokens SET name=?, symbol=?, decimals=?, total_supply=?, enriched=1 WHERE address=?',
    ),
    markEnriched: db.prepare('UPDATE tokens SET enriched=1 WHERE address=?'),
    pending: db.prepare('SELECT address FROM tokens WHERE enriched=0 ORDER BY transfers DESC LIMIT ?'),
    // ERC-721 also answers name() and symbol(), so symbol alone does not identify a
    // fungible token. Requiring decimals + totalSupply is what separates them.
    top: db.prepare(`
      SELECT address,name,symbol,decimals,total_supply,source,first_block,transfers
      FROM tokens WHERE enriched=1 AND symbol IS NOT NULL
        AND decimals IS NOT NULL AND total_supply IS NOT NULL
      ORDER BY transfers DESC LIMIT ? OFFSET ?`),
    tokenCount: db.prepare(`
      SELECT COUNT(*) AS n FROM tokens WHERE enriched=1 AND symbol IS NOT NULL
        AND decimals IS NOT NULL AND total_supply IS NOT NULL`),
    counts: db.prepare(
      'SELECT (SELECT COUNT(*) FROM tokens) AS tokens, (SELECT COUNT(*) FROM tokens WHERE enriched=1) AS enriched, (SELECT COUNT(*) FROM launches) AS launches',
    ),
    upsertLaunch: db.prepare(`
      INSERT INTO launches(commit_hash,creator,phase,commit_block) VALUES(?,?,?,?)
      ON CONFLICT(commit_hash) DO NOTHING`),
    revealLaunch: db.prepare(`
      UPDATE launches SET token=?, curve=?, name=?, symbol=?, metadata_uri=?, phase='CURVE_LIVE', reveal_block=?
      WHERE commit_hash=?`),
    setPhase: db.prepare('UPDATE launches SET phase=? WHERE token=?'),
    listLaunches: db.prepare('SELECT * FROM launches ORDER BY reveal_block DESC LIMIT ?'),
    addTrade: db.prepare(`
      INSERT INTO trades(tx,log_index,token,side,trader,native_amt,token_amt,block)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tx,log_index) DO NOTHING`),
    addReferral: db.prepare(`
      INSERT INTO referrals(token,trader,referrer,block) VALUES(?,?,?,?)
      ON CONFLICT(token,trader) DO NOTHING`),
    curveToken: db.prepare('SELECT token FROM launches WHERE lower(curve) = lower(?)'),
    // A "boost" is a buy by someone who arrived through a referral link. Joining trades to
    // referrals is what distinguishes it from an ordinary buy — there is no separate event.
    tradesSince: db.prepare(
      'SELECT token, side, trader, native_amt, token_amt, block FROM trades WHERE block >= ? ORDER BY block ASC, log_index ASC',
    ),
    allTrades: db.prepare(
      'SELECT token, side, trader, native_amt, token_amt, block FROM trades ORDER BY block ASC, log_index ASC',
    ),
    // Own query rather than filtering allTrades in JS: this hits idx_trade_token, and the
    // terminal is the only caller that needs the tx hash.
    tradesOfToken: db.prepare(
      `SELECT tx, token, side, trader, native_amt, token_amt, block FROM trades
       WHERE lower(token) = lower(?) ORDER BY block ASC, log_index ASC`,
    ),
    firstTouch: db.prepare('SELECT token, trader, MIN(block) AS first_block FROM trades GROUP BY token, lower(trader)'),
    launchMeta: db.prepare('SELECT token, curve, symbol, name, creator, phase, reveal_block, metadata_uri FROM launches WHERE token IS NOT NULL'),
    booster: db.prepare(`
      SELECT t.token, t.trader AS buyer, r.referrer, t.native_amt, t.block, t.tx,
             l.symbol, l.name, l.curve
      FROM trades t
      JOIN referrals r ON r.token = t.token AND lower(r.trader) = lower(t.trader)
      LEFT JOIN launches l ON lower(l.token) = lower(t.token)
      WHERE t.side = 'buy'
      ORDER BY t.block DESC, t.log_index DESC
      LIMIT ?`),
  };

  return {
    db,
    cursor(role: string): bigint | null {
      const r = q.getCursor.get(role) as { last_block: number } | undefined;
      return r ? BigInt(r.last_block) : null;
    },
    setCursor: (role: string, block: bigint) => q.setCursor.run(role, Number(block)),
    seenToken: (addr: string, block: bigint, source = 'unknown') =>
      q.seenToken.run(addr, Number(block), source),
    enrich: (addr: string, name: string | null, symbol: string | null, decimals: number | null, supply: string | null) =>
      name === null && symbol === null ? q.markEnriched.run(addr) : q.enrich.run(name, symbol, decimals, supply, addr),
    pending: (limit: number) => (q.pending.all(limit) as { address: string }[]).map((r) => r.address),
    top: (limit: number, offset = 0) => q.top.all(limit, offset) as TokenRow[],
    tokenCount: () => (q.tokenCount.get() as { n: number }).n,
    counts: () => q.counts.get() as { tokens: number; enriched: number; launches: number },
    upsertLaunch: (hash: string, creator: string, block: bigint) =>
      q.upsertLaunch.run(hash, creator, 'COMMITTED', Number(block)),
    revealLaunch: (hash: string, token: string, curve: string, name: string, symbol: string, uri: string, block: bigint) =>
      q.revealLaunch.run(token, curve, name, symbol, uri, Number(block), hash),
    setPhase: (token: string, phase: string) => q.setPhase.run(phase, token),
    listLaunches: (limit: number) => q.listLaunches.all(limit) as Record<string, unknown>[],
    addTrade: (t: { tx: string; logIndex: number; token: string; side: string; trader: string; native: bigint; tokens: bigint; block: bigint }) =>
      q.addTrade.run(t.tx, t.logIndex, t.token, t.side, t.trader, t.native.toString(), t.tokens.toString(), Number(t.block)),
    addReferral: (token: string, trader: string, referrer: string, block: bigint) =>
      q.addReferral.run(token, trader, referrer, Number(block)),
    /** Which coin a curve address belongs to. Returns null for anything we did not launch. */
    tokenOfCurve: (curve: string) =>
      (q.curveToken.get(curve) as { token: string } | undefined)?.token ?? null,
    booster: (limit: number) => q.booster.all(limit) as Record<string, unknown>[],
    tradesSince: (block: number) => q.tradesSince.all(block) as TradeRow[],
    allTrades: () => q.allTrades.all() as TradeRow[],
    tradesOfToken: (token: string) => q.tradesOfToken.all(token) as (TradeRow & { tx: string })[],
    firstTouch: () => q.firstTouch.all() as { token: string; trader: string; first_block: number }[],
    launchMeta: () => q.launchMeta.all() as LaunchMetaRow[],
  };
}

export type TradeRow = {
  token: string;
  side: 'buy' | 'sell';
  trader: string;
  native_amt: string;
  token_amt: string;
  block: number;
};

export type LaunchMetaRow = {
  token: string;
  curve: string | null;
  symbol: string | null;
  name: string | null;
  creator: string;
  phase: string;
  reveal_block: number | null;
  metadata_uri: string | null;
};

export type Store = ReturnType<typeof openStore>;
