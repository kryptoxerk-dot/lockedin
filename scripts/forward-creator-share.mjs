/**
 * The creator's half, sent on to the buyback vault.
 *
 * The fee split on pump.fun is 50/50 and frozen: half of every distribution
 * goes to the vault, half to the creator wallet, and nobody can ever change
 * that. This makes it 100% in practice, from FORWARD_SINCE onward: whatever
 * the creator received from a distribution, it sends to the vault, where the
 * next keeper cycle buys and locks with it like any other fee.
 *
 * It is a promise the creator keeps, not one the program enforces, so it is
 * kept in the open. Everything it does is read back from the chain, not from
 * its own memory:
 *
 *   owed       the creator's half of every DistributeCreatorFees transaction
 *              since FORWARD_SINCE: the smaller of what the vault and the creator
 *              each received in it (5,000 bps each, so equal), so nothing but
 *              fees is ever owed. See lib/forwarding.mjs.
 *   forwarded  every plain SOL transfer from the creator to the vault since then.
 *
 * It sends owed - forwarded and nothing else, to the vault and nowhere else.
 * If it crashes after sending, the transfer is on chain and counted on the
 * next scan, so it cannot pay twice. If its state file is lost, it rescans.
 *
 *   LOCKEDIN_MINT=<mint> FORWARD_SINCE=<ISO time> CREATOR_ADDRESS=<pubkey> node scripts/forward-creator-share.mjs --once
 *   ... CREATOR_WALLET_PATH=<keypair.json> node scripts/forward-creator-share.mjs --execute
 *
 * Without --execute it only reports what it would send.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

import { priorityFee, sendAndConfirm, vaultPda } from "./lib/cycle.mjs";
import { feeState } from "./lib/fees.mjs";
import { classifyTransaction, transferAmount } from "./lib/forwarding.mjs";
import { rpcLabel, rpcErrorMessage } from "./lib/rpc-log.mjs";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const INTERVAL_MS = Math.max(30_000, Number(process.env.FORWARD_INTERVAL_MS ?? 60_000));
const STATE = process.env.FORWARD_STATE_PATH ?? "state/forwarder.json";
const RECEIPTS = process.env.FORWARD_RECEIPTS_PATH ?? "data/forwarder.jsonl";
// What the website shows: the ledger and whether transfers are switched on.
const STATUS = process.env.FORWARD_STATUS_PATH ?? "data/forwarder-status.json";
// Below this a transfer is mostly its own fee; it waits and goes with the next one.
const MIN_LAMPORTS = BigInt(process.env.FORWARD_MIN_LAMPORTS ?? 5_000_000);
// Left in the creator wallet so it can always pay for its own transactions.
const RESERVE_LAMPORTS = BigInt(process.env.CREATOR_RESERVE_LAMPORTS ?? 10_000_000);
// A ceiling on any single transfer. Larger amounts owed go over several ticks.
const MAX_LAMPORTS = BigInt(process.env.FORWARD_MAX_LAMPORTS ?? 1_000_000_000);
const once = process.argv.includes("--once");
const execute = process.argv.includes("--execute") || process.env.FORWARD_EXECUTE === "1";

const fail = (msg) => { console.error(msg); process.exit(2); };
if (!process.env.LOCKEDIN_MINT) fail("Set LOCKEDIN_MINT.");
const since = Date.parse(process.env.FORWARD_SINCE ?? "");
if (!Number.isFinite(since)) fail("Set FORWARD_SINCE to the ISO time forwarding starts from.");
const mint = new PublicKey(process.env.LOCKEDIN_MINT);
const vault = vaultPda(mint);

let signer = null;
if (execute) {
  const p = process.env.CREATOR_WALLET_PATH;
  if (!p || !fs.existsSync(p)) fail("--execute needs CREATOR_WALLET_PATH, the creator wallet's keypair.");
  signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
const creator = signer?.publicKey ?? (process.env.CREATOR_ADDRESS ? new PublicKey(process.env.CREATOR_ADDRESS) : null);
if (!creator) fail("Set CREATOR_ADDRESS (or CREATOR_WALLET_PATH with --execute).");

const connection = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: false });

function receipt(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), mint: mint.toBase58(), ...event });
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(RECEIPTS), { recursive: true });
    fs.appendFileSync(RECEIPTS, line + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`could not write a receipt: ${e.message}`);
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    // A state file from another mint, creator or start time is not this ledger.
    if (s.mint === mint.toBase58() && s.creator === creator.toBase58() && s.since === since) {
      return { ...s, owed: BigInt(s.owed), forwarded: BigInt(s.forwarded) };
    }
  } catch { /* first run, or lost: rescan */ }
  return { mint: mint.toBase58(), creator: creator.toBase58(), since, cursor: null, owed: 0n, forwarded: 0n, distributions: 0, transfers: 0 };
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...s, owed: String(s.owed), forwarded: String(s.forwarded) }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

/** Vault signatures newer than the cursor and no older than FORWARD_SINCE, oldest first. */
async function newSignatures(cursor) {
  const out = [];
  let before;
  for (;;) {
    const page = await connection.getSignaturesForAddress(vault, { until: cursor ?? undefined, before, limit: 1000 });
    let reachedStart = false;
    for (const s of page) {
      if (s.blockTime != null && s.blockTime * 1000 < since) { reachedStart = true; break; }
      out.push(s);
    }
    if (reachedStart || page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse();
}

const limits = { min: MIN_LAMPORTS, reserve: RESERVE_LAMPORTS, max: MAX_LAMPORTS };

async function classify(signature) {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
  if (!tx) return null; // not served yet: stop here and retry from this point next tick
  return classifyTransaction(tx, vault.toBase58(), creator.toBase58());
}

async function scan(state) {
  const sigs = await newSignatures(state.cursor);
  for (const s of sigs) {
    const r = await classify(s.signature);
    if (!r) break;
    state.owed += r.owed;
    state.forwarded += r.forwarded;
    if (r.owed) state.distributions++;
    if (r.forwarded) state.transfers++;
    state.cursor = s.signature;
  }
  saveState(state);
}

/** The creator must be the fee split's other shareholder, and the vault its 50%. */
async function checkSplit() {
  const fs_ = await feeState(connection, mint, null, { check: false });
  const byAddr = new Map(fs_.shareholders.map((s) => [s.address, s.shareBps]));
  if (fs_.editable !== false || byAddr.get(vault.toBase58()) !== 5000 || byAddr.get(creator.toBase58()) !== 5000) {
    fail(`fee split is not the frozen 50/50 of vault ${vault.toBase58()} and creator ${creator.toBase58()}; refusing to run`);
  }
}

function publish(status) {
  try {
    fs.mkdirSync(path.dirname(STATUS), { recursive: true });
    fs.writeFileSync(STATUS + ".tmp", JSON.stringify({
      updatedAt: new Date().toISOString(), mode: execute ? "executing" : "read-only",
      since: new Date(since).toISOString(), creator: creator.toBase58(), vault: vault.toBase58(), ...status,
    }));
    fs.renameSync(STATUS + ".tmp", STATUS);
  } catch (e) {
    console.error(`could not write the status file: ${e.message}`);
  }
}

let pendingUntil = 0;
async function tick(state) {
  await scan(state);
  const due = state.owed - state.forwarded;
  const status = { owed: String(state.owed), forwarded: String(state.forwarded), due: String(due > 0n ? due : 0n) };
  publish(status);
  if (due < MIN_LAMPORTS) return;
  if (Date.now() < pendingUntil) return receipt({ kind: "forward-pending", ...status });

  const balance = BigInt(await connection.getBalance(creator));
  const amount = transferAmount(due, balance, limits);
  if (amount === 0n) {
    return receipt({ kind: "forward-waiting", ...status, creatorLamports: String(balance), reason: "creator wallet balance is below what is owed plus its reserve" });
  }
  if (!execute) return receipt({ kind: "would-forward", ...status, lamports: String(amount) });

  const tx = new Transaction().add(
    ...priorityFee(),
    SystemProgram.transfer({ fromPubkey: creator, toPubkey: vault, lamports: amount }),
  );
  tx.feePayer = creator;
  // Until this blockhash expires, a timed-out send may still land; the scan
  // will count it if it does. Sending again before then could pay twice.
  pendingUntil = Date.now() + 150_000;
  try {
    const signature = await sendAndConfirm(connection, tx, [signer]);
    pendingUntil = 0;
    receipt({ kind: "forwarded", ...status, lamports: String(amount), signature });
    publish({ ...status, forwarded: String(state.forwarded + amount), due: String(due - amount) });
  } catch (e) {
    receipt({ kind: "forward-error", ...status, lamports: String(amount), message: rpcErrorMessage(e, RPC) });
  }
}

await checkSplit();
const state = loadState();
console.log(JSON.stringify({
  at: new Date().toISOString(), kind: "start", rpc: rpcLabel(RPC), mint: mint.toBase58(), vault: vault.toBase58(),
  creator: creator.toBase58(), since: new Date(since).toISOString(), mode: execute ? "executing" : "read-only",
}));

let running = false;
async function safeTick() {
  if (running) return;
  running = true;
  try {
    await tick(state);
  } catch (e) {
    receipt({ kind: "forward-tick-error", message: rpcErrorMessage(e, RPC) });
  } finally {
    running = false;
  }
}
await safeTick();
if (once) {
  console.log(JSON.stringify({ kind: "ledger", owed: String(state.owed), forwarded: String(state.forwarded), distributions: state.distributions, transfers: state.transfers }));
} else {
  setInterval(safeTick, INTERVAL_MS);
}
