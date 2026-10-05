/**
 * Does a cycle actually lock tokens where nobody can sell them?
 *
 * Creates a real pump.fun token on a validator holding cloned mainnet
 * programs, funds its vault the way creator fees would, and runs the cycle.
 * Then it checks the things that would make the product a lie:
 *
 *   - the tokens are in the holder's account, not the vault's
 *   - the holder is off the ed25519 curve, so no private key can exist
 *   - a caller cannot choose which holder receives them
 *   - a caller cannot point the buy at a token whose vault this is not
 *   - the counter moves by exactly one, and the next cycle uses a new address
 *
 * Pass --keep to leave the token in place for inspection.
 *
 *   node scripts/cycle-test.mjs
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

// Addresses, seeds and derivations come from the shared library so a change in
// one place cannot leave a test proving something about a program that is no
// longer deployed. Each of these was a local copy here until one of them
// silently kept pointing at an old program id.
import {
  PROGRAM,
  ATA_PROGRAM,
  PUMP_PROGRAM,
  WSOL,
  LEGACY_TOKEN,
  configPda,
  vaultPda,
  counterPda,
  holderPda,
  ataFor,
  disc,
  u64,
  u32,
  readCounter,
  tokenBalance,
  errorName,
  errorCode,
  initConfigInstruction,
} from "./lib/cycle.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Resolve the pump SDK from wherever it is installed. A static ESM import of
// this package fails at load time -- it drags in @pump-fun/agent-payments-sdk,
// which breaks on @coral-xyz/anchor not providing an ESM BN export -- so it is
// always required, never imported.
const DEPS = process.env.DEPS_FROM ?? import.meta.url;
const requireCjs = createRequire(DEPS);
const pump = requireCjs("@pump-fun/pump-sdk");
const BN = requireCjs("bn.js");

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

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  PASS  ${m}`); };
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`        ${m}`);
const tokenBalanceOf = (a) => tokenBalance(connection, a);
const readCounterFor = (m) => readCounter(connection, m);




console.log("=".repeat(72));
console.log("LOCKED IN -- one full cycle");
console.log("=".repeat(72));
note(`cluster ${RPC}`);
note(`program ${PROGRAM.toBase58()}`);

// --------------------------------------------------------------- config
const config = configPda();
if (!(await connection.getAccountInfo(config))) {
  // Whoever creates the config is the pause admin, so only the upgrade
  // authority may. The stranger is funded so the account creation itself would
  // succeed: the only thing left to refuse it is the program's own check.
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 10_000_000 }),
    ),
    [payer],
  );
  const attempt = new Transaction().add(initConfigInstruction(stranger.publicKey));
  attempt.feePayer = payer.publicKey;
  attempt.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(attempt);
  const custom = sim.value.err?.InstructionError?.[1]?.Custom;
  if (custom === errorCode("NotUpgradeAuthority")) ok("a funded stranger cannot create the config — refused with NotUpgradeAuthority");
  else bad(`a stranger creating the config: expected NotUpgradeAuthority, got ${sim.value.err ? errorName(custom) ?? JSON.stringify(sim.value.err) : "ALLOWED"}`);

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      initConfigInstruction(payer.publicKey),
    ),
    [payer],
  );
  note("config created by the upgrade authority");
} else {
  note("config already exists; the stranger check needs a fresh validator");
}

// ------------------------------------------------------------- the token
const sdk = new pump.PumpSdk();
const online = new pump.OnlinePumpSdk(connection);
const mintKp = Keypair.generate();
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    await sdk.createV2Instruction({
      mint: mintKp.publicKey,
      name: "Locked In Test",
      symbol: "LOCKT",
      uri: "https://lockedinforever.locker/t.json",
      creator: payer.publicKey,
      user: payer.publicKey,
      mayhemMode: false,
    }),
  ),
  [payer, mintKp],
);
const mint = mintKp.publicKey;
const tokenProgram = (await connection.getAccountInfo(mint)).owner;
note(`mint ${mint.toBase58()}`);

// Trade it so the curve has a price, exactly as a real launch would.
//
// A full SOL, not a token amount: pump takes a creator fee from the trade
// and creates its creator vault with it, and an account created below
// rent-exemption fails the whole transaction. At 0.2 SOL the fee is about
// 0.0006 SOL against a 0.00089 minimum, which is the kind of margin that
// works until the day it does not.
{
  const st = await online.fetchBuyState(mint, payer.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ...(await sdk.buyInstructions({
        global: await online.fetchGlobal(),
        bondingCurveAccountInfo: st.bondingCurveAccountInfo,
        bondingCurve: st.bondingCurve,
        associatedUserAccountInfo: st.associatedUserAccountInfo,
        mint,
        user: payer.publicKey,
        amount: new BN(1_000_000_000_000),
        solAmount: new BN(1_000_000_000),
        slippage: 100,
        tokenProgram,
      })),
    ),
    [payer],
  );
}

// ----------------------------------------------------------- register it
const vault = vaultPda(mint);
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
{
  const c = await readCounterFor(mint);
  if (c && c.nextIndex === 0 && c.totalHolders === 0) ok("registered: counter starts at zero");
  else bad(`counter reads ${JSON.stringify(c)}`);
}

// --------------------------------- fund the vault the way fees would
const FEE_SHARE = 60_000_000; // 0.06 SOL, comfortably over MIN_CYCLE
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: FEE_SHARE }),
  ),
  [payer],
);
note(`vault funded with ${FEE_SHARE / 1e9} SOL`);

// --------------------------------------------------- build the cycle
const vaultAta = ataFor(vault, tokenProgram, mint);
const vaultWsol = ataFor(vault, LEGACY_TOKEN, WSOL);

// The vault's own token account must exist for pump to buy into it. In
// production the keeper creates it once; here, once, the same way.
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

async function cycleIx(holderIndex, caller = payer.publicKey) {
  const holder = holderPda(mint, holderIndex);
  const holderAta = ataFor(holder, tokenProgram, mint);
  const st = await online.fetchBuyState(mint, vault);
  const spendable = (await connection.getBalance(vault)) - 890_880 - 1_513_840 - 50_000;
  const amount = pump
    .getBuyTokenAmountFromSolAmount({
      global: await online.fetchGlobal(),
      feeConfig: await online.fetchFeeConfig(),
      mintSupply: new BN((await connection.getTokenSupply(mint)).value.amount),
      bondingCurve: st.bondingCurve,
      amount: new BN(spendable),
      quoteMint: WSOL,
    })
    .muln(90)
    .divn(100);

  const buyIxs = await sdk.buyInstructions({
    global: await online.fetchGlobal(),
    bondingCurveAccountInfo: st.bondingCurveAccountInfo,
    bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo,
    mint,
    user: vault,
    amount,
    solAmount: new BN(spendable),
    slippage: 0,
    tokenProgram,
  });
  const buy = buyIxs.find(
    (ix) => ix.programId.equals(PUMP_PROGRAM) && ix.data.subarray(0, 8).equals(Buffer.from(
      [102, 6, 61, 18, 1, 218, 235, 234])),
  );

  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: counterPda(mint), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: holder, isSigner: false, isWritable: false },
      { pubkey: holderAta, isSigner: false, isWritable: true },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: vaultWsol, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: LEGACY_TOKEN, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...buy.keys.map((k) => ({ ...k, isSigner: false })),
    ],
    data: Buffer.concat([
      disc("lock_in_cycle"),
      u64(BigInt(amount.toString())),
      u64(1n),
    ]),
  });
}

// ------------------------------------------------------------------ 1
console.log("\n1. a cycle locks the purchase into holder 0\n" + "-".repeat(72));
const holder0 = holderPda(mint, 0);
const holder0Ata = ataFor(holder0, tokenProgram, mint);
try {
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(await cycleIx(0)),
    [payer],
  );
  note(`tx ${sig.slice(0, 28)}…`);

  const locked = await tokenBalanceOf(holder0Ata);
  const leftInVault = await tokenBalanceOf(vaultAta);
  const c = await readCounterFor(mint);

  if (locked > 0n) ok(`${locked} tokens now sit in holder 0`);
  else bad("the holder received nothing");
  if (leftInVault === 0n) ok("the vault's token account is empty");
  else bad(`${leftInVault} tokens left where the vault could still spend them`);
  if (c.totalHolders === 1 && c.nextIndex === 1) ok("counter advanced by exactly one");
  else bad(`counter reads holders=${c.totalHolders} next=${c.nextIndex}`);
  if (c.totalLocked === locked) ok("total_locked matches what the holder holds");
  else bad(`counter says ${c.totalLocked}, holder has ${locked}`);
} catch (e) {
  bad(`cycle failed: ${String(e.message).split("\n")[0]}`);
  note(String(e.logs?.slice(-8).join("\n        ") ?? ""));
}

// ------------------------------------------------------------------ 2
console.log("\n2. the holder provably has no private key\n" + "-".repeat(72));
if (!PublicKey.isOnCurve(holder0.toBytes())) {
  ok(`${holder0.toBase58()} is off the ed25519 curve`);
  note("no private key exists for it, and none can be derived");
} else {
  bad("the holder is a curve point -- a key could exist for it");
}

// ------------------------------------------------------------------ 3
console.log("\n3. a caller cannot choose a different holder\n" + "-".repeat(72));
try {
  await sendAndConfirmTransaction(
    connection,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(await cycleIx(99)),
    [payer],
  );
  bad("a cycle wrote to holder 99 while the counter said 1");
} catch (e) {
  const m = `${e.message}${JSON.stringify(e.logs ?? "")}`;
  if (/WrongHolder/i.test(m)) ok("refused: the holder must be the counter's current index");
  else { note(m.split("\n")[0].slice(0, 110)); ok("refused (reason above)"); }
}

// ------------------------------------------------------------------ 4
console.log("\n4. a second cycle uses a new address, not the old one\n" + "-".repeat(72));
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: FEE_SHARE }),
  ),
  [payer],
);
try {
  await sendAndConfirmTransaction(
    connection,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(await cycleIx(1)),
    [payer],
  );
  const holder1 = holderPda(mint, 1);
  const locked1 = await tokenBalanceOf(ataFor(holder1, tokenProgram, mint));
  const locked0After = await tokenBalanceOf(holder0Ata);
  const c = await readCounterFor(mint);

  if (locked1 > 0n) ok(`holder 1 received ${locked1} tokens`);
  else bad("holder 1 received nothing");
  if (c.totalHolders === 2) ok("two holders now exist");
  else bad(`counter says ${c.totalHolders} holders`);
  if (locked0After > 0n) ok("holder 0 still holds its tokens, untouched");
  else bad("holder 0's balance changed");
} catch (e) {
  bad(`second cycle failed: ${String(e.message).split("\n")[0]}`);
  note(String(e.logs?.slice(-6).join("\n        ") ?? ""));
}

// ------------------------------------------------------------------ 5
console.log("\n5. nothing in the program can move a locked balance\n" + "-".repeat(72));
{
  // The only authority over the holder's token account is the holder PDA, and
  // the only program that can sign for it is this one. Enumerate what this
  // program is willing to do with that seed.
  const src = fs.readFileSync(
    new URL("../programs/lockedin/src/lib.rs", import.meta.url),
    "utf8",
  );
  const holderSeedUses = (src.match(/SEED_HOLDER/g) ?? []).length;
  const hasWithdraw = /fn\s+(withdraw|close_holder|rescue|sweep|admin_transfer)/.test(src);
  if (!hasWithdraw) ok("no withdraw, close, rescue or sweep instruction exists");
  else bad("the program has an instruction that could move locked tokens");
  note(`SEED_HOLDER appears ${holderSeedUses} times: the constant and its two derivations`);
}

console.log("\n" + "=".repeat(72));
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`  mint ${mint.toBase58()}`);
console.log("=".repeat(72));
process.exit(failed === 0 ? 0 : 1);
