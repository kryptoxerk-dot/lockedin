/**
 * Build the lookup table a cycle needs, once per mint.
 *
 * Run this after the token exists and before the first cycle. It reads the
 * accounts from a cycle actually built against the live market rather than
 * from a list written down here, so it stays right when pump changes theirs.
 *
 * Re-running is safe: an existing table is extended with whatever it lacks and
 * otherwise left alone.
 *
 *   node scripts/make-alt.mjs --mint <mint>
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROGRAM, MIN_CYCLE, buildCycle, readCounter } from "./lib/cycle.mjs";
import { ensureLookupTable, tableAddressesFor } from "./lib/alt.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.WALLET_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json"),
        "utf8",
      ),
    ),
  ),
);

const i = process.argv.indexOf("--mint");
if (i < 0 || !process.argv[i + 1]) {
  console.error("usage: node scripts/make-alt.mjs --mint <mint>");
  process.exit(2);
}
const mint = new PublicKey(process.argv[i + 1]);

// The vault is usually empty when this runs, so the budget is pretended. The
// instruction that comes back is read for its accounts and never sent.
const counter = await readCounter(connection, mint);
const built = await buildCycle(connection, {
  mint,
  caller: payer.publicKey,
  index: counter ? counter.nextIndex : 0,
  marginPercent: 92,
  budgetOverride: MIN_CYCLE * 4,
});
if (!built.ready) {
  console.error(`could not build a cycle to read accounts from: ${built.reason}`);
  process.exit(1);
}

const addresses = tableAddressesFor(built, {
  payer: payer.publicKey,
  program: PROGRAM,
  computeBudget: ComputeBudgetProgram.programId,
});

console.log(`mint    ${mint.toBase58()}`);
console.log(`path    ${built.graduated ? "PumpSwap" : "bonding curve"}`);
console.log(`needs   ${addresses.length} accounts in a table`);

const { address, table } = await ensureLookupTable(
  connection, payer, mint, addresses, (m) => console.log(`        ${m}`),
);

console.log(`ready   ${table.state.addresses.length} entries, usable now`);
console.log("");
console.log(`  LOCKEDIN_ALT=${address.toBase58()}`);
