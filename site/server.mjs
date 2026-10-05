/**
 * The dashboard's server: read the chain, cache it, serve it.
 *
 * The dashboard is most of the product -- "N addresses that can never sell,
 * here is every one of them" -- so what it says has to be true even when it is
 * inconvenient. Two rules follow from that:
 *
 *   Everything counted here is counted from the chain, never from the keeper's
 *   own log. A dashboard that reports what the keeper believes it did is a
 *   dashboard that keeps reporting success after the keeper has stopped
 *   working. Signatures are the one thing taken from the receipts, because a
 *   transaction hash is a pointer, not a claim -- and anything without one is
 *   still listed.
 *
 *   A reading that could not be refreshed is served with its age, not hidden.
 *   The page shows how old it is rather than pretending it is current.
 *
 * It exists at all because the browser cannot poll a public RPC every few
 * seconds for every visitor without being rate-limited into showing zeros.
 *
 *   LOCKEDIN_MINT=<mint> node site/server.mjs
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROGRAM,
  ataFor,
  counterPda,
  holderPda,
  isGraduated,
  readCounter,
  vaultPda,
} from "../scripts/lib/cycle.mjs";
import { feeState } from "../scripts/lib/fees.mjs";
import { MAINNET_GENESIS, programPermanence } from "../scripts/lib/permanence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");

const PORT = Number(process.env.PORT ?? 8787);
const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const REFRESH_MS = Math.max(10_000, Number(process.env.REFRESH_MS ?? 30_000));
const RECEIPTS = process.env.KEEPER_RECEIPTS_PATH ?? path.join(HERE, "..", "data", "receipts.jsonl");

const mint = process.env.LOCKEDIN_MINT ? new PublicKey(process.env.LOCKEDIN_MINT) : null;
const vault = mint ? vaultPda(mint) : null;
const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true });
const CLUSTER = process.env.SOLANA_CLUSTER ?? "mainnet-beta";
let networkVerified = false;

async function verifyNetwork() {
  if (!networkVerified && CLUSTER === "mainnet-beta") {
    if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("Configured RPC is not Solana mainnet");
    networkVerified = true;
  }
}


/**
 * Signatures, keyed by cycle index, from whatever the keeper has written.
 *
 * Read fresh each time rather than held: the keeper appends while this runs.
 * A missing file is normal -- the keeper may be on another host -- and costs
 * the page its explorer links, not its numbers.
 */
function receiptsByIndex() {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(RECEIPTS, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.kind === "locked" && r.mint === mint?.toBase58() && typeof r.index === "number") {
        out.set(r.index, { signature: r.signature, at: r.at, market: r.market });
      }
    }
  } catch { /* no receipts here */ }
  return out;
}

/** The keeper's own health, which is a fact about the keeper, labelled as one. */
function keeperHealth() {
  try {
    const lines = fs.readFileSync(RECEIPTS, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (!r.at || r.mint !== mint?.toBase58()) continue;
        const ageMs = Date.now() - new Date(r.at).getTime();
        return { lastKind: r.kind, lastAt: r.at, ageMs, reason: r.reason ?? null };
      } catch { /* keep looking back */ }
    }
  } catch { /* none */ }
  return null;
}

let snapshot = { ready: false, error: "not read yet" };
let holderCache = { at: 0, list: [] };

async function refresh() {
  if (!mint) {
    snapshot = { ready: false, phase: "prelaunch", program: PROGRAM.toBase58(), cluster: CLUSTER, updatedAt: new Date().toISOString() };
    return;
  }
  await verifyNetwork();
  const counter = await readCounter(connection, mint);
  if (!counter) {
    snapshot = {
      ready: false,
      phase: "unregistered",
      program: PROGRAM.toBase58(),
      cluster: CLUSTER,
      error: "this mint is not registered with the mechanism yet",
      mint: mint.toBase58(),
      updatedAt: new Date().toISOString(),
    };
    return;
  }

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error("Configured mint does not exist on this network");
  const tokenProgram = mintInfo.owner;
  const supply = await connection.getTokenSupply(mint);
  const graduated = await isGraduated(connection, mint).catch(() => null);
  const split = await feeState(connection, mint, null, { check: false }).catch(() => null);
  const vaultLamports = await connection.getBalance(vault);
  const commitment = await programPermanence(connection).catch(() => ({ immutable: null, adminRenounced: null, paused: null }));

  const locked = BigInt(counter.totalLocked);
  const total = BigInt(supply.value.amount);

  snapshot = {
    ready: true,
    phase: "registered",
    cluster: CLUSTER,
    permanence: commitment,
    updatedAt: new Date().toISOString(),
    mint: mint.toBase58(),
    vault: vault.toBase58(),
    counter: counterPda(mint).toBase58(),
    program: PROGRAM.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    holders: counter.totalHolders,
    nextIndex: counter.nextIndex,
    totalLocked: counter.totalLocked.toString(),
    decimals: supply.value.decimals,
    supply: supply.value.amount,
    lockedPercent: total > 0n ? Number((locked * 1_000_000n) / total) / 10_000 : 0,
    vaultLamports,
    graduated,
    market: graduated === null ? null : graduated ? "pumpswap" : "bonding-curve",
    split: split
      ? {
          exists: split.exists,
          editable: split.editable,
          shareholders: split.shareholders,
          vaultBps: split.shareholders.find((s) => s.address === vault.toBase58())?.shareBps ?? null,
        }
      : null,
    keeper: keeperHealth(),
  };
}

/**
 * Every holder, read one page at a time.
 *
 * The addresses are derived, not stored: `["hold", mint, index]` for index 0
 * upward. Anyone can do the same and get the same list, which is the point --
 * see /derivation on the page. Balances come from each address's token account.
 */
async function holders(from, count) {
  if (!mint) return { total: 0, from, holders: [] };
  await verifyNetwork();
  const counter = await readCounter(connection, mint);
  if (!counter) return { total: 0, from, holders: [] };
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error("Configured mint is unavailable");
  const tokenProgram = mintInfo.owner;

  const end = Math.min(from + count, counter.nextIndex);
  const indices = [];
  for (let i = from; i < end; i++) indices.push(i);

  const addresses = indices.map((i) => holderPda(mint, i));
  const atas = addresses.map((a) => ataFor(a, tokenProgram, mint));

  const infos = [];
  for (let n = 0; n < atas.length; n += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(atas.slice(n, n + 100))));
  }

  const receipts = receiptsByIndex();
  return {
    total: counter.nextIndex,
    from,
    holders: indices.map((index, n) => {
      const info = infos[n];
      const r = receipts.get(index) ?? {};
      return {
        index,
        address: addresses[n].toBase58(),
        tokenAccount: atas[n].toBase58(),
        amount: info?.owner.equals(tokenProgram) && info.data.length >= 72 ? info.data.readBigUInt64LE(64).toString() : null,
        // Proof the address has no private key, restated per row rather than
        // asserted once at the top: it is the whole claim.
        offCurve: !PublicKey.isOnCurve(addresses[n].toBytes()),
        signature: r.signature ?? null,
        at: r.at ?? null,
        market: r.market ?? null,
      };
    }),
  };
}

// --------------------------------------------------------------------- serve
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(text);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // The typefaces come from Google Fonts: its stylesheet host and its font host.
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, phase: snapshot.phase ?? "unavailable" });

  if (url.pathname === "/api/state") {
    const ageMs = snapshot.updatedAt ? Date.now() - new Date(snapshot.updatedAt).getTime() : null;
    return json(res, 200, { ...snapshot, ageMs, refreshMs: REFRESH_MS });
  }

  if (url.pathname === "/api/holders") {
    const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
    const count = Math.min(200, Math.max(1, Number(url.searchParams.get("count") ?? 50) | 0));
    // Cached briefly: a visitor paging through should not cost one RPC round
    // trip per keystroke, and the list only changes when a cycle runs.
    const key = `${from}:${count}`;
    if (holderCache.key === key && Date.now() - holderCache.at < 15_000) {
      return json(res, 200, holderCache.body);
    }
    try {
      const body = await holders(from, count);
      holderCache = { key, at: Date.now(), body };
      return json(res, 200, body);
    } catch (e) {
      return json(res, 502, { error: "Holder balances could not be read from the network. Please try again shortly." });
    }
  }

  // Static, with the path confined to the public directory.
  let file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC, file);
  const relative = path.relative(PUBLIC, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403).end("no");
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(full)] ?? "application/octet-stream",
      "cache-control": file === "index.html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
});

await refresh().catch((e) => {
  snapshot = { ready: false, phase: "unavailable", program: PROGRAM.toBase58(), cluster: CLUSTER, mint: mint?.toBase58() ?? null, error: "Chain data could not be read for the configured mint", updatedAt: new Date().toISOString() };
});
let refreshing = false;
setInterval(async () => {
  // A failed refresh keeps the previous snapshot and lets its age show, rather
  // than replacing real numbers with an error.
  if (refreshing) return;
  refreshing = true;
  try { await refresh(); } catch { console.error("chain refresh failed; preserving the last reading"); }
  finally { refreshing = false; }
}, REFRESH_MS);

server.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      kind: "listening",
      port: PORT,
      cluster: CLUSTER,
      mint: mint?.toBase58() ?? null,
      vault: vault?.toBase58() ?? null,
      refreshMs: REFRESH_MS,
    }),
  );
});
