/**
 * The page, without a chain behind it.
 *
 * Working on the dashboard against a live cluster means the interesting states
 * are the ones you cannot summon: no cycles yet, a stale reading, a keeper
 * that has stopped, an address that is somehow on the curve. Those are exactly
 * the states worth getting right, so they are served from here instead.
 *
 *   node site/dev-fixture.mjs             # a populated, healthy page
 *   SCENE=empty node site/dev-fixture.mjs # before the first cycle
 *   SCENE=stale node site/dev-fixture.mjs # a reading that could not refresh
 *   SCENE=curve node site/dev-fixture.mjs # still on the bonding curve
 *
 * This serves fixtures. It is not the server; see server.mjs.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT ?? 8788);
const SCENE = process.env.SCENE ?? "full";

const HOLDERS = 137;
const DECIMALS = 6;

// Deterministic, so a screenshot from one run is comparable to the next.
const pseudo = (n) => {
  let h = (n * 2654435761) >>> 0;
  return () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
};
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeKey = (seed, len = 44) => {
  const r = pseudo(seed);
  let s = "";
  for (let i = 0; i < len; i++) s += b58[Math.floor(r() * b58.length)];
  return s;
};

const state = () => {
  if (SCENE === "prelaunch") return { ready: false, phase: "prelaunch", cluster: "mainnet-beta", ageMs: 0, refreshMs: 30_000 };
  const empty = SCENE === "empty";
  const stale = SCENE === "stale";
  const curve = SCENE === "curve" || empty;
  const holders = empty ? 0 : HOLDERS;
  const locked = empty ? "0" : "48210377412885";
  return {
    ready: true,
    cluster: "mainnet-beta",
    permanence: { immutable: SCENE !== "upgradeable", adminRenounced: true, paused: false },
    updatedAt: new Date(Date.now() - (stale ? 20 * 60_000 : 4_000)).toISOString(),
    ageMs: stale ? 20 * 60_000 : 4_000,
    refreshMs: 30_000,
    rpc: "https://api.mainnet-beta.solana.com",
    mint: fakeKey(1),
    vault: fakeKey(2),
    counter: fakeKey(3),
    program: "EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    holders,
    nextIndex: holders,
    totalLocked: locked,
    decimals: DECIMALS,
    supply: "1000000000000000",
    lockedPercent: empty ? 0 : 4.821,
    vaultLamports: empty ? 890880 : 31_400_000,
    graduated: !curve,
    market: curve ? "bonding-curve" : "pumpswap",
    split: curve
      ? { exists: false, editable: null, shareholders: [], vaultBps: null }
      : {
          exists: true,
          editable: false,
          vaultBps: 5000,
          shareholders: [
            { address: fakeKey(2), shareBps: 5000 },
            { address: fakeKey(9), shareBps: 5000 },
          ],
        },
    keeper: stale
      ? { lastKind: "error", lastAt: new Date(Date.now() - 40 * 60_000).toISOString(), ageMs: 40 * 60_000, reason: "rpc timeout" }
      : empty
        ? { lastKind: "waiting", lastAt: new Date().toISOString(), ageMs: 3_000, reason: "below the minimum cycle" }
        : { lastKind: "locked", lastAt: new Date(Date.now() - 51_000).toISOString(), ageMs: 51_000, reason: null },
  };
};

const holdersPage = (from, count) => {
  const total = SCENE === "empty" ? 0 : HOLDERS;
  const end = Math.min(from + count, total);
  const list = [];
  for (let i = from; i < end; i++) {
    const r = pseudo(i + 100);
    list.push({
      index: i,
      address: fakeKey(i + 1000),
      tokenAccount: fakeKey(i + 5000),
      amount: String(Math.floor(r() * 900_000_000_000) + 40_000_000_000),
      // One row deliberately wrong, so the page is seen failing loudly rather
      // than only ever seen passing.
      offCurve: i !== 3,
      signature: i % 7 === 0 ? null : fakeKey(i + 9000, 88),
      at: new Date(Date.now() - (total - i) * 90_000).toISOString(),
      market: i > 20 ? "pumpswap" : "bonding-curve",
    });
  }
  return { total, from, holders: list };
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/state") return json(state());
    if (url.pathname === "/api/holders") {
      return json(
        holdersPage(Number(url.searchParams.get("from") ?? 0), Number(url.searchParams.get("count") ?? 50)),
      );
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) return res.writeHead(403).end();
    fs.readFile(full, (err, data) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": TYPES[path.extname(full)] ?? "text/plain" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`fixture "${SCENE}" on http://localhost:${PORT}`));
