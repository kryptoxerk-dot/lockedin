/**
 * The keeper: the thing that calls a permissionless instruction so nobody has
 * to sit there doing it.
 *
 * It holds no authority and no funds beyond its own transaction fees. Every
 * rent a cycle pays comes from the vault, so this wallet does not drain as the
 * token trades. That is deliberate: a keeper that fronts per-cycle rent it
 * never recovers runs dry after a dozen or so cycles, then declines once a
 * minute while looking exactly like a token that had stopped earning fees.
 *
 * If this process stops, the mechanism does not. Anyone can run a cycle; this
 * is a convenience, not a dependency.
 *
 *   LOCKEDIN_MINT=<mint> node scripts/keeper.mjs --once
 *   LOCKEDIN_MINT=<mint> node scripts/keeper.mjs            # loop
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCycle,
  confirmSuccess,
  errorName,
  isSlippage,
  programError,
  readCounter,
  settleAndBuild,
  signAndSend,
  simulateBuilt,
  tokenBalance,
  vaultPda,
  MIN_CYCLE,
  priorityFee,
} from "./lib/cycle.mjs";
import { loadLookupTable } from "./lib/alt.mjs";
import { distributeInstructions } from "./lib/fees.mjs";
import { rpcLabel, rpcErrorMessage } from "./lib/rpc-log.mjs";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const INTERVAL_MS = Math.max(15_000, Number(process.env.KEEPER_INTERVAL_MS ?? 60_000));
const RECEIPTS = process.env.KEEPER_RECEIPTS_PATH ?? "data/receipts.jsonl";
const once = process.argv.includes("--once");
const execute = process.argv.includes("--execute") || process.env.KEEPER_EXECUTE === "1";

const mintFlag = process.argv.indexOf("--mint");
const mintArg = process.env.LOCKEDIN_MINT ?? (mintFlag >= 0 ? process.argv[mintFlag + 1] : null);
if (!mintArg || mintArg.startsWith("--")) {
  console.error("Set LOCKEDIN_MINT, or pass --mint <address>.");
  process.exit(2);
}
const mint = new PublicKey(mintArg);

const walletPath =
  process.env.KEEPER_WALLET_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");
if (!fs.existsSync(walletPath)) {
  console.error(`No keeper wallet at ${walletPath}. Set KEEPER_WALLET_PATH.`);
  process.exit(2);
}
const keeper = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
);

const connection = new Connection(RPC, "confirmed");

/**
 * Everything the keeper does or declines to do, as one line of JSON.
 *
 * Including the refusals. A keeper that logs only its successes is
 * indistinguishable from one that has quietly stopped working.
 */
function receipt(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(RECEIPTS), { recursive: true });
    fs.appendFileSync(RECEIPTS, line + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`could not write a receipt: ${rpcErrorMessage(e, RPC)}`);
  }
}

/**
 * Find a slippage margin that fits, by asking the cluster rather than guessing.
 *
 * A fixed margin is a guess about a fee schedule, and a wrong guess costs a
 * whole cycle: the buy reverts and the fees sit until someone notices. A flat
 * 1% has been seen to revert on mainnet where 2.5% was needed. Each
 * step buys fewer tokens for the same SOL, so the first that simulates is the
 * largest lock this balance can pay for.
 */
const MARGINS = [99, 97, 95, 92, 88, 82, 75];

async function attempt(index, lookupTables) {
  let lastReason = null;
  const prepared = [];

  for (const marginPercent of MARGINS) {
    const options = { mint, caller: keeper.publicKey, index, marginPercent, lookupTables };

    // Creating the fee accounts has to happen before simulating, not after.
    // An earlier version simulated first and only prepared once a simulation
    // succeeded, which meant it never prepared at all: the missing accounts
    // are exactly what made the simulation fail. The keeper would have sat
    // there refusing every cycle, on a token that was earning fees normally.
    const built = execute
      ? await settleAndBuild(connection, options, keeper)
      : await buildCycle(connection, options);

    if (!built.ready) return { ready: false, reason: built.reason, budget: built.budget };
    for (const p of built.prepared ?? []) {
      prepared.push(p);
      receipt({ kind: "prepared", mint: mint.toBase58(), accounts: p.accounts, signature: p.signature });
    }
    if (built.prepare?.length) {
      // Read-only. Say what is missing rather than simulating a transaction
      // that cannot work and reporting the symptom.
      return {
        ready: false,
        reason: `${built.prepare.length} fee account(s) must be created first; run with --execute`,
        budget: built.budget,
      };
    }

    const sim = await simulateBuilt(connection, built, keeper.publicKey);
    if (!sim.err) return { ready: true, built, marginPercent, prepared };

    const code = programError(sim);
    // Our own program refusing is a fact about the state, not the price.
    // Buying less will not change it, so stop and say which refusal it was.
    if (code !== null && code >= 6000) {
      return { ready: false, reason: `refused: ${errorName(code)}`, code };
    }
    if (!isSlippage(sim)) {
      // Everything there is, not the first line that matched a word. A failure
      // with no matching log line used to be reported as "simulation failed:
      // unknown", which is the keeper describing its own blind spot and
      // calling it a diagnosis.
      const interesting = (sim.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l));
      return {
        ready: false,
        reason: `simulation failed at a ${100 - marginPercent}% margin: ${JSON.stringify(sim.err)}`,
        err: sim.err ?? null,
        logs: (interesting.length ? interesting : (sim.logs ?? []).slice(-6)).map((l) => l.slice(0, 180)),
      };
    }
    lastReason = `slippage at a ${100 - marginPercent}% margin`;
  }
  return { ready: false, reason: `${lastReason}; no margin up to 25% fitted` };
}

/**
 * Move the creator fees out of pump and into the shareholders.
 *
 * Without this the vault balance never rises and every tick reports "below the
 * minimum cycle" on a token that is trading normally, with the fees sitting in
 * plain view in a pump-owned account. The same instruction pays the deployer
 * their half, so neither side depends on anyone forwarding anything.
 *
 * It is separate from the cycle on purpose. It touches no capital of ours and
 * can fail on its own -- pump holding less than their distributable minimum is
 * the ordinary case, not a fault.
 */
async function claimFees() {
  const { instructions, reason, state } = await distributeInstructions(
    connection, mint, keeper.publicKey,
  );
  if (!instructions) return { claimed: false, reason };
  if (!execute) return { claimed: false, reason: `${state.distributableLamports} lamports distributable; read-only` };

  const tx = new Transaction().add(...priorityFee(), ...instructions);
  tx.feePayer = keeper.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(keeper);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await confirmSuccess(connection, { signature, blockhash, lastValidBlockHeight });
  receipt({
    kind: "fees-distributed",
    mint: mint.toBase58(),
    lamports: state.distributableLamports.toString(),
    graduated: state.graduated,
    shareholders: state.shareholders.length,
    signature,
  });
  return { claimed: true, lamports: state.distributableLamports };
}

async function tick() {
  const vault = vaultPda(mint);
  const gas = await connection.getBalance(keeper.publicKey);
  if (gas < 10_000_000) {
    receipt({ kind: "insufficient-gas", mint: mint.toBase58(), keeper: keeper.publicKey.toBase58(), lamports: gas, reason: "Keeper needs at least 0.01 SOL for transaction fees; first-cycle account preparation needs additional funds" });
    return;
  }

  const counter = await readCounter(connection, mint);
  if (!counter) {
    receipt({ kind: "not-registered", mint: mint.toBase58(), vault: vault.toBase58() });
    return;
  }

  // Before looking at the vault, not after: the balance this reads is the
  // balance the claim just produced.
  let feeReason = null;
  try {
    ({ reason: feeReason } = await claimFees());
  } catch (e) {
    receipt({ kind: "fee-claim-error", mint: mint.toBase58(), message: rpcErrorMessage(e, RPC) });
  }

  const lamports = await connection.getBalance(vault);

  // A PumpSwap cycle names 33 accounts and does not fit in a legacy
  // transaction, so past graduation the table is not optional. Refusing here
  // with the reason is better than sending something that cannot be encoded.
  const { table, reason: tableReason } = await loadLookupTable(connection, mint);
  const lookupTables = table ? [table] : [];

  const built = await attempt(counter.nextIndex, lookupTables);

  if (!built.ready) {
    receipt({
      kind: "waiting",
      mint: mint.toBase58(),
      index: counter.nextIndex,
      vaultLamports: lamports,
      reason: built.reason,
      ...(built.logs ? { logs: built.logs } : {}),
      ...(tableReason ? { lookupTable: tableReason } : {}),
      ...(feeReason ? { fees: feeReason } : {}),
    });
    return;
  }

  if (!execute) {
    receipt({
      kind: "ready",
      mint: mint.toBase58(),
      index: counter.nextIndex,
      wouldSpend: built.built.budget,
      margin: built.marginPercent,
      note: "read-only; pass --execute to submit",
    });
    return;
  }

  try {
    const signature = await signAndSend(connection, built.built, keeper);

    // Read the result back rather than trusting what was asked for. The public
    // endpoint is a pool and the node that confirms a write is not necessarily
    // the one that answers the next read, so retry until it appears.
    let locked = 0n;
    for (let i = 0; i < 8 && locked === 0n; i++) {
      locked = await tokenBalance(connection, built.built.holderAta);
      if (locked === 0n) await new Promise((r) => setTimeout(r, 1500));
    }

    const updatedCounter = await readCounter(connection, mint);
    if (locked === 0n || !updatedCounter || updatedCounter.nextIndex <= built.built.index) {
      receipt({ kind: "verification-pending", mint: mint.toBase58(), index: built.built.index, signature, reason: "Transaction confirmed, but holder balance and counter could not both be read back" });
      return;
    }

    receipt({
      kind: "locked",
      mint: mint.toBase58(),
      index: built.built.index,
      holder: built.built.holder.toBase58(),
      signature,
      tokens: locked.toString(),
      spent: built.built.budget,
      margin: built.marginPercent,
      market: built.built.graduated ? "pumpswap" : "bonding-curve",
      bytes: built.built.versioned ? built.built.transaction.serialize().length : null,
    });
  } catch (e) {
    receipt({
      kind: "error",
      mint: mint.toBase58(),
      index: counter.nextIndex,
      message: rpcErrorMessage(e, RPC),
    });
  }
}

console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    kind: "start",
    rpc: rpcLabel(RPC),
    mint: mint.toBase58(),
    vault: vaultPda(mint).toBase58(),
    keeper: keeper.publicKey.toBase58(),
    mode: execute ? "executing" : "read-only",
    intervalMs: INTERVAL_MS,
    minCycle: MIN_CYCLE,
  }),
);

// Serialised: a tick that overruns the interval must not start a second one
// against the same holder index, which would waste a transaction fee on a
// cycle the first is about to consume.
let running = false;
async function safeTick() {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (e) {
    receipt({ kind: "tick-error", mint: mint.toBase58(), message: rpcErrorMessage(e, RPC) });
  } finally {
    running = false;
  }
}

await safeTick();
if (!once) setInterval(safeTick, INTERVAL_MS);
