/**
 * Does a cycle work on PumpSwap, where the token spends its life?
 *
 * The bonding curve lasts hours. PumpSwap is the rest, and it is a different
 * instruction: a different account layout, a wrapped-SOL account created and
 * closed inside the same transaction, a pool that must be derived rather than
 * accepted from a caller, and several fee-recipient token accounts the pool
 * will not create for you. None of that is touched by the curve tests.
 *
 * A pool cannot be made here -- pump's migration is permissioned and wants a
 * withdraw authority only they hold -- so this runs against a real graduated
 * token whose pool is cloned into the validator from mainnet. Real liquidity,
 * real fee schedule, our vault doing the buying.
 *
 *   node scripts/amm-test.mjs [--mint <graduated mint>]
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  PROGRAM,
  ATA_PROGRAM,
  WSOL,
  LEGACY_TOKEN,
  configPda,
  vaultPda,
  counterPda,
  holderPda,
  ataFor,
  disc,
  readCounter,
  tokenBalance,
  buildCycle,
  isGraduated,
  signAndSend,
  settleAndBuild,
  simulateBuilt,
  errorCode,
  transactionSize,
  initConfigInstruction,
} from "./lib/cycle.mjs";
import { ensureLookupTable, loadLookupTable, tableAddressesFor } from "./lib/alt.mjs";

const requireCjs = createRequire(import.meta.url);
const amm = requireCjs("@pump-fun/pump-swap-sdk");

import { requireLocalValidator } from "./lib/test-cluster.mjs";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
requireLocalValidator(RPC);
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

const argIndex = process.argv.indexOf("--mint");
const mint = new PublicKey(
  argIndex >= 0 && process.argv[argIndex + 1]
    ? process.argv[argIndex + 1]
    : "8izFifHZJHQMSKRxHo7fJDEUuCdkTD5KQSf3pwMBRhnd",
);

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  PASS  ${m}`); };
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`        ${m}`);

console.log("=".repeat(72));
console.log("LOCKED IN -- a cycle on PumpSwap");
console.log("=".repeat(72));
note(`mint ${mint.toBase58()}`);

// ------------------------------------------------------------------ 1
console.log("\n1. the cloned market is really there\n" + "-".repeat(72));
const mintInfo = await connection.getAccountInfo(mint);
if (!mintInfo) {
  bad("the mint is not on this validator; add it to ops/validator.sh");
  process.exit(1);
}
const tokenProgram = mintInfo.owner;

if (await isGraduated(connection, mint)) ok("the bonding curve is complete");
else bad("this token has not graduated, so it has no pool to trade on");

const poolKey = amm.canonicalPumpPoolPda(mint, WSOL);
if (await connection.getAccountInfo(poolKey)) {
  ok(`pool ${poolKey.toBase58()} present, owned by PumpSwap`);
} else {
  bad(`pool ${poolKey.toBase58()} is missing; regenerate the clone list`);
  process.exit(1);
}

// ------------------------------------------------------------------ setup
const config = configPda();
if (!(await connection.getAccountInfo(config))) {
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      initConfigInstruction(payer.publicKey),
    ),
    [payer],
  );
}

const vault = vaultPda(mint);
if (!(await connection.getAccountInfo(counterPda(mint)))) {
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: counterPda(mint), isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: disc("init_token"),
      }),
    ),
    [payer],
  );
}

const vaultAta = ataFor(vault, tokenProgram, mint);
if (!(await connection.getAccountInfo(vaultAta))) {
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      new TransactionInstruction({
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    ),
    [payer],
  );
}

const before = await readCounter(connection, mint);
const index = before.nextIndex;

await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 80_000_000 }),
  ),
  [payer],
);
note(`vault funded, running cycle ${index}`);

// ------------------------------------------------------------------ 2
console.log("\n2. the builder picks the PumpSwap path by itself\n" + "-".repeat(72));
const built = await buildCycle(connection, {
  mint,
  caller: payer.publicKey,
  index,
  marginPercent: 92,
});

if (!built.ready) {
  bad(`no cycle built: ${built.reason}`);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(1);
}
if (built.graduated) ok("read the curve and chose PumpSwap over the bonding curve");
else bad("chose the bonding-curve path for a graduated token");

// ------------------------------------------------------------------ 3
console.log("\n3. it does not fit without a lookup table, and does with one\n" + "-".repeat(72));
const legacyBytes = transactionSize(built, payer.publicKey);
if (legacyBytes > 1232) {
  note(`a legacy transaction would be ${legacyBytes} bytes, over the 1232 limit`);
} else {
  note(`a legacy transaction is ${legacyBytes} bytes; it would fit today`);
}

const { address: altAddress, table } = await ensureLookupTable(
  connection,
  payer,
  mint,
  tableAddressesFor(built, {
    payer: payer.publicKey,
    program: PROGRAM,
    computeBudget: ComputeBudgetProgram.programId,
  }),
  (m) => note(m),
);
ok(`lookup table ${altAddress.toBase58()} holds ${table.state.addresses.length} accounts`);

const loaded = await loadLookupTable(connection, mint);
if (loaded.table) ok("the table is warm and loadable the way the keeper loads it");
else bad(`the table is not usable: ${loaded.reason}`);

// ------------------------------------------------------------------ 4
console.log("\n4. the accounts PumpSwap will not create for us\n" + "-".repeat(72));
// PumpSwap picks one of eight protocol fee recipients at random per build, so
// this is a loop, not a step: it keeps building until a build comes back
// needing nothing. A single pass would appear to work and then fail on send
// roughly seven times in eight.
const settled = await settleAndBuild(
  connection,
  { mint, caller: payer.publicKey, index, marginPercent: 92, lookupTables: [loaded.table] },
  payer,
);
for (const p of settled.prepared) note(`created ${p.accounts} account(s) in ${p.signature.slice(0, 16)}\u2026`);
if (settled.ready) {
  ok(`a sendable cycle after ${settled.prepared.length} round(s) of preparation`);
} else {
  bad(`never settled: ${settled.reason}`);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ------------------------------------------------------------------ 5
console.log("\n5. the cycle\n" + "-".repeat(72));
const vaultBefore = await connection.getBalance(vault);
try {
  const bytes = settled.transaction.serialize().length;
  if (bytes <= 1232) ok(`the cycle is ${bytes} bytes, ${1232 - bytes} under the limit`);
  else bad(`the cycle is ${bytes} bytes even with the table`);

  // The dust buy, on PumpSwap. The spend floor is measured differently here
  // -- from the wrapped SOL, not the vault's lamports -- so it needs its own
  // proof rather than borrowing the curve's.
  const dust = await buildCycle(connection, {
    mint, caller: payer.publicKey, index, marginPercent: 1,
    lookupTables: [loaded.table],
  });
  if (dust.ready) {
    const sim = await simulateBuilt(connection, dust, payer.publicKey);
    const code = sim.err?.InstructionError?.[1]?.Custom;
    if (code === errorCode("UnderSpent")) ok("a one-percent buy on PumpSwap is refused with UnderSpent");
    else bad(`a one-percent buy on PumpSwap was not refused as UnderSpent: ${JSON.stringify(sim.err)}`);
  } else {
    bad(`could not build the dust attempt: ${dust.reason}`);
  }

  // Sent exactly as built. Rebuilding here would pick a fresh fee recipient
  // and undo the settling above.
  const sig = await signAndSend(connection, settled, payer);
  note(`tx ${sig.slice(0, 28)}\u2026`);

  const holder = holderPda(mint, index);
  const locked = await tokenBalance(connection, ataFor(holder, tokenProgram, mint));
  const leftInVault = await tokenBalance(connection, vaultAta);
  const after = await readCounter(connection, mint);
  const wsol = await connection.getAccountInfo(ataFor(vault, LEGACY_TOKEN, WSOL));
  const vaultAfter = await connection.getBalance(vault);

  if (locked > 0n) ok(`${locked} tokens locked into holder ${index} on PumpSwap`);
  else bad("the holder received nothing");
  if (leftInVault === 0n) ok("the vault's token account is empty");
  else bad(`${leftInVault} tokens left where the vault could still spend them`);
  if (after.totalHolders === before.totalHolders + 1) ok("the counter advanced by one");
  else bad(`holders went ${before.totalHolders} -> ${after.totalHolders}`);
  if (!wsol) ok("the wrapped-SOL account was closed back into the vault");
  else bad("the wrapped-SOL account is still open, holding rent the vault paid");
  if (!PublicKey.isOnCurve(holder.toBytes())) ok("the holder has no private key");
  else bad("the holder is a curve point");
  note(`vault ${vaultBefore} -> ${vaultAfter} lamports`);
} catch (e) {
  bad(`the AMM cycle failed: ${String(e.message).split("\n")[0].slice(0, 150)}`);
  let logs = e.logs ?? [];
  if (!logs.length && typeof e.getLogs === "function") {
    logs = (await e.getLogs(connection).catch(() => [])) ?? [];
  }
  for (const l of logs.filter((l) => /Error|error|failed/i.test(l)).slice(0, 5)) {
    note(l.slice(0, 145));
  }
}

console.log("\n" + "=".repeat(72));
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(72));
process.exit(failed === 0 ? 0 : 1);
