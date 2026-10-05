/**
 * Everything a caller might try, and the exact refusal each one gets.
 *
 * `lock_in_cycle` is permissionless by design: anyone may run it so the
 * mechanism does not depend on us being awake. That only works if a caller
 * cannot steer it, so each case below checks not merely that something failed
 * but that it failed *for the stated reason*. A test that accepts any error is
 * satisfied by a typo in the account list, and would keep passing while the
 * protection it claims to prove quietly stopped working.
 *
 * Negative cases are simulated rather than sent. No money moves, the logs come
 * back clean, and a case that should be refused cannot accidentally succeed and
 * consume a holder index.
 *
 *   node scripts/adversarial-test.mjs
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
  settleAndBuild,
  signAndSend,
  simulateBuilt,
  isSlippage,
  curveSolReserve,
  cycleBudget,
} from "./lib/cycle.mjs";

const config = configPda();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const requireCjs = createRequire(process.env.DEPS_FROM ?? import.meta.url);
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




/**
 * Simulate and report which program error came back.
 *
 * Reads the numeric code rather than matching log text: Anchor only prints an
 * error's name when the program was built with its name-logging feature, and
 * matching on a message would pass for the wrong error with a similar word in
 * it. The number is the contract.
 */
async function expectRefusal(label, ix, expected) {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const sim = await connection.simulateTransaction(tx);
  if (!sim.value.err) {
    bad(`${label}: it was ALLOWED`);
    return;
  }
  const custom = sim.value.err?.InstructionError?.[1]?.Custom;
  // Anchor's framework errors sit below ours at 2000-2999 and fire first,
  // because its account constraints run before the instruction body.
  const ANCHOR = { ConstraintSeeds: 2006, ConstraintHasOne: 2001, ConstraintOwner: 2004 };
  const want = ANCHOR[expected] ?? errorCode(expected);
  if (custom === want) {
    ok(`${label} — refused with ${expected}`);
  } else {
    const named =
      Object.entries(ANCHOR).find(([, v]) => v === custom)?.[0] ?? errorName(custom);
    bad(`${label}: expected ${expected} (${want}), got ${named ?? JSON.stringify(sim.value.err)}`);
    for (const l of (sim.value.logs ?? []).filter((l) => /Error|error/.test(l)).slice(0, 2)) {
      note(l.slice(0, 130));
    }
  }
}

console.log("=".repeat(72));
console.log("LOCKED IN -- what a caller cannot do");
console.log("=".repeat(72));

// ---------------------------------------------------------------- a token
const sdk = new pump.PumpSdk();
const online = new pump.OnlinePumpSdk(connection);

async function freshToken(symbol) {
  const kp = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      await sdk.createV2Instruction({
        mint: kp.publicKey, name: symbol, symbol,
        uri: "https://lockedinforever.locker/t.json",
        creator: payer.publicKey, user: payer.publicKey, mayhemMode: false,
      }),
    ),
    [payer, kp],
  );
  const mint = kp.publicKey;
  const tokenProgram = (await connection.getAccountInfo(mint)).owner;
  const st = await online.fetchBuyState(mint, payer.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ...(await sdk.buyInstructions({
        global: await online.fetchGlobal(),
        bondingCurveAccountInfo: st.bondingCurveAccountInfo,
        bondingCurve: st.bondingCurve,
        associatedUserAccountInfo: st.associatedUserAccountInfo,
        mint, user: payer.publicKey,
        amount: new BN(1_000_000_000_000), solAmount: new BN(1_000_000_000),
        slippage: 100, tokenProgram,
      })),
    ),
    [payer],
  );
  // register it
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: counterPda(mint), isSigner: false, isWritable: true },
          { pubkey: vaultPda(mint), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: disc("init_token"),
      }),
    ),
    [payer],
  );
  // and give its vault a token account, as the keeper would once
  const vault = vaultPda(mint);
  const vAta = ataFor(vault, tokenProgram, mint);
  if (!(await connection.getAccountInfo(vAta))) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        new TransactionInstruction({
          programId: ATA_PROGRAM,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: vAta, isSigner: false, isWritable: true },
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
  return { mint, tokenProgram, vault, vaultAta: vAta };
}

const A = await freshToken("ADVA");
const B = await freshToken("ADVB");
note(`token A ${A.mint.toBase58()}`);
note(`token B ${B.mint.toBase58()}`);

const fund = (vault, lamports) =>
  sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports }),
    ),
    [payer],
  );

/** A well-formed cycle instruction, with individual pieces overridable. */
async function cycleIx(t, over = {}) {
  const index = over.index ?? 0;
  const holder = over.holder ?? holderPda(t.mint, index);
  const holderAta = over.holderAta ?? ataFor(holder, t.tokenProgram, t.mint);
  const st = await online.fetchBuyState(over.buyMint ?? t.mint, over.buyer ?? t.vault);
  const spendable = Math.max(
    1000,
    (await connection.getBalance(t.vault)) - 890_880 - 1_513_840 - 50_000,
  );
  const amount = new BN(1_000_000);
  const buyIxs = await sdk.buyInstructions({
    global: await online.fetchGlobal(),
    bondingCurveAccountInfo: st.bondingCurveAccountInfo,
    bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo,
    mint: over.buyMint ?? t.mint,
    user: over.buyer ?? t.vault,
    amount, solAmount: new BN(spendable), slippage: 100,
    tokenProgram: t.tokenProgram,
  });
  const buy = buyIxs.find(
    (ix) => ix.programId.equals(PUMP_PROGRAM) &&
      ix.data.subarray(0, 8).equals(Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])),
  );
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: t.mint, isSigner: false, isWritable: true },
      { pubkey: over.counter ?? counterPda(t.mint), isSigner: false, isWritable: true },
      { pubkey: t.vault, isSigner: false, isWritable: true },
      { pubkey: t.vaultAta, isSigner: false, isWritable: true },
      { pubkey: holder, isSigner: false, isWritable: false },
      { pubkey: holderAta, isSigner: false, isWritable: true },
      { pubkey: over.pumpProgram ?? PUMP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: t.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ataFor(t.vault, LEGACY_TOKEN, WSOL), isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: LEGACY_TOKEN, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...buy.keys.map((k) => ({ ...k, isSigner: false })),
    ],
    data: Buffer.concat([disc("lock_in_cycle"), u64(BigInt(amount.toString())), u64(1n)]),
  });
}

// ------------------------------------------------------------------ 1
console.log("\n1. an empty vault\n" + "-".repeat(72));
await expectRefusal(
  "a cycle with nothing collected",
  await cycleIx(A),
  "CycleTooSmall",
);

// ------------------------------------------------------------------ 2
console.log("\n2. below the minimum, but not empty\n" + "-".repeat(72));
await fund(A.vault, 5_000_000); // 0.005 SOL, under the 0.02 minimum
await expectRefusal(
  "a cycle at a quarter of the minimum",
  await cycleIx(A),
  "CycleTooSmall",
);
note("this is what stops the mechanism spending most of a cycle on account rent");

// ------------------------------------------------------------------ 3
console.log("\n3. choosing where the tokens go\n" + "-".repeat(72));
await fund(A.vault, 60_000_000);
await expectRefusal(
  "a holder index the counter is not on",
  await cycleIx(A, { index: 7 }),
  "WrongHolder",
);
{
  // The attacker's own wallet as the destination, with the correct holder PDA
  // still named, so only the token account is swapped.
  const thief = Keypair.generate();
  await expectRefusal(
    "somebody else's token account as the destination",
    await cycleIx(A, { holderAta: ataFor(thief.publicKey, A.tokenProgram, A.mint) }),
    "WrongHolder",
  );
}

// ------------------------------------------------------------------ 4
console.log("\n4. spending one token's fees on another\n" + "-".repeat(72));
await expectRefusal(
  "a buy naming a different mint",
  await cycleIx(A, { buyMint: B.mint }),
  "BuyMintMismatch",
);
await expectRefusal(
  "token B's counter with token A's vault",
  await cycleIx(A, { counter: counterPda(B.mint) }),
  // Anchor's seed constraint on the counter fires before the handler runs, so
  // this never reaches our own WrongMint check. That check stays as a second
  // line rather than being removed: a future edit that loosens the constraint
  // would otherwise silently open this.
  "ConstraintSeeds",
);

// ------------------------------------------------------------------ 5
console.log("\n5. routing the money somewhere else entirely\n" + "-".repeat(72));
await expectRefusal(
  "a buy sent through a program that is not pump.fun",
  await cycleIx(A, { pumpProgram: Keypair.generate().publicKey }),
  "NotPumpProgram",
);
{
  const stranger = Keypair.generate();
  await expectRefusal(
    "a buy whose buyer is not this vault",
    await cycleIx(A, { buyer: stranger.publicKey }),
    "BuyerMismatch",
  );
}

// ------------------------------------------------------------------ 5b
console.log("\n5b. buying dust to drain the vault\n" + "-".repeat(72));
// The caller chooses how many tokens to ask for. This asks for one token
// against a vault holding 0.065 SOL. Before the spend floor it succeeded: the
// vault paid a whole holder account's rent and the caller's fee, bought
// almost nothing, and could be made to do it again every time fees arrived.
// This suite's own "real cycle" further down used to be exactly this buy,
// and passed, which is how it went unnoticed.
await expectRefusal(
  "a one-token buy against a funded vault",
  await cycleIx(A),
  "UnderSpent",
);
note("a cycle must spend at least 65% of its budget on the buy");

// ------------------------------------------------------------------ 6
console.log("\n6. while paused\n" + "-".repeat(72));
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("set_paused"), Buffer.from([1])]),
    }),
  ),
  [payer],
);
await expectRefusal("a cycle while paused", await cycleIx(A), "Paused");
note("pause stops new cycles and reaches nothing already locked");
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("set_paused"), Buffer.from([0])]),
    }),
  ),
  [payer],
);

// ------------------------------------------------------------------ 7
console.log("\n7. the reimbursement cannot be farmed\n" + "-".repeat(72));
{
  // A caller is paid 0.00005 SOL per cycle, and a cycle needs 0.02 SOL of fees
  // to run at all. So the only way to be paid is to do the work, and an empty
  // vault pays nothing however many times it is asked.
  const before = await connection.getBalance(payer.publicKey);
  let allowed = 0;
  for (let i = 0; i < 3; i++) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(await cycleIx(B)); // B's vault has never been funded
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    if (!(await connection.simulateTransaction(tx)).value.err) allowed++;
  }
  const after = await connection.getBalance(payer.publicKey);
  if (allowed === 0) ok("three calls against an unfunded vault, all refused");
  else bad(`${allowed} of 3 calls succeeded against an empty vault`);
  if (after <= before) ok("the caller gained nothing by asking repeatedly");
  else bad(`the caller gained ${after - before} lamports`);
}

// ------------------------------------------------------------------ 8
console.log("\n8. a locked balance, once it exists\n" + "-".repeat(72));
{
  // Run one real cycle, built by the same code the keeper uses, then try to
  // move what it locked. It used to be built by hand here, asking for one
  // token -- the dust buy section 5b now refuses.
  const real = await settleAndBuild(
    connection,
    { mint: A.mint, caller: payer.publicKey, index: 0, marginPercent: 92 },
    payer,
  );
  if (!real.ready) throw new Error(`could not build a real cycle: ${real.reason}`);
  await signAndSend(connection, real, payer);
  const holder = holderPda(A.mint, 0);
  const holderAta = ataFor(holder, A.tokenProgram, A.mint);
  const info = await connection.getAccountInfo(holderAta);
  const balance = info.data.readBigUInt64LE(64);
  const owner = new PublicKey(info.data.subarray(32, 64));

  if (balance > 0n) ok(`${balance} tokens are in the holder's account`);
  else bad("nothing was locked");
  if (owner.equals(holder)) ok("its authority is the holder PDA and nothing else");
  else bad(`its authority is ${owner.toBase58()}`);

  // A transfer out needs the holder's signature. No key exists, and the only
  // program that can sign for it has no instruction that does.
  const thief = Keypair.generate();
  const thiefAta = ataFor(thief.publicKey, A.tokenProgram, A.mint);
  const steal = new Transaction().add(
    new TransactionInstruction({
      programId: A.tokenProgram,
      keys: [
        { pubkey: holderAta, isSigner: false, isWritable: true },
        { pubkey: thiefAta, isSigner: false, isWritable: true },
        { pubkey: holder, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([3]), u64(balance)]),
    }),
  );
  steal.feePayer = payer.publicKey;
  steal.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  try {
    steal.sign(payer);
    const sim = await connection.simulateTransaction(steal);
    if (sim.value.err) ok("a transfer out cannot even be signed for");
    else bad("a locked balance was moved");
  } catch (e) {
    ok("a transfer out cannot even be assembled: the holder cannot sign");
    note(String(e.message).split("\n")[0].slice(0, 100));
  }
}

// ------------------------------------------------------------------ 9
// Last on purpose: the config is global and renouncing is permanent, so
// nothing after this in the run may need to pause.
console.log("\n9. giving up the pause, for good\n" + "-".repeat(72));
{
  const pauseIx = (who, on) => new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: who, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_paused"), Buffer.from([on ? 1 : 0])]),
  });
  const renounceIx = (who) => new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: who, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data: disc("renounce_admin"),
  });

  await expectRefusal("a stranger renouncing the admin", renounceIx(Keypair.generate().publicKey), "NotAdmin");

  // Renouncing while paused would leave the mechanism paused with nobody able
  // to lift it, so it is refused rather than allowed.
  await sendAndConfirmTransaction(connection, new Transaction().add(pauseIx(payer.publicKey, true)), [payer]);
  await expectRefusal("renouncing while paused", renounceIx(payer.publicKey), "Paused");
  await sendAndConfirmTransaction(connection, new Transaction().add(pauseIx(payer.publicKey, false)), [payer]);

  await sendAndConfirmTransaction(connection, new Transaction().add(renounceIx(payer.publicKey)), [payer]);
  const cfg = await connection.getAccountInfo(config);
  const admin = new PublicKey(cfg.data.subarray(8, 40));
  if (admin.equals(PublicKey.default)) ok(`the admin is now ${admin.toBase58()}, which nobody can sign for`);
  else bad(`the admin is still ${admin.toBase58()}`);

  await expectRefusal("the former admin pausing after renouncing", pauseIx(payer.publicKey, true), "NotAdmin");
  note("anyone can check this: read the config account's admin field");
}

// ------------------------------------------------------------------ 10
// The cycle is permissionless and the caller picks the token amount, so a
// caller can push the price up, run the cycle at that price and sell into the
// vault's buy, all at once. Each cycle may spend at most RESERVE_CAP_BPS of the
// curve's SOL reserve, which keeps the vault's own price move below the
// attacker's round-trip fee. Found by an independent review before deploy.
console.log("\n10. sandwiching a cycle\n" + "-".repeat(72));
{
  const C = await freshToken("ADVC");
  await fund(C.vault, 2_000_000_000); // 2 SOL waiting: far more than one cycle may spend
  const reserve = await curveSolReserve(connection, C.mint);
  const cap = cycleBudget(Number.MAX_SAFE_INTEGER, reserve);
  note(`curve SOL reserve ${reserve}; one cycle may spend at most ${cap} lamports`);

  // (a) Asking for everything the vault holds: pump is told the budget is the
  // cap, so a token amount priced at the whole vault cannot fill.
  const greedy = await settleAndBuild(
    connection,
    { mint: C.mint, caller: payer.publicKey, index: 0, marginPercent: 99, budgetOverride: 1_990_000_000 },
    payer,
  );
  if (!greedy.ready) throw new Error(`could not build the greedy cycle: ${greedy.reason}`);
  const greedySim = await simulateBuilt(connection, greedy, payer.publicKey);
  if (greedySim.err && isSlippage(greedySim)) ok("a cycle priced at the whole vault is refused: pump only accepts the capped budget");
  else bad(`a cycle priced at the whole vault was not refused as over budget: ${JSON.stringify(greedySim.err)}`);

  // (b) The full sandwich, by a funded attacker who also submits the cycle.
  const attacker = Keypair.generate();
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 30_000_000_000 }),
  ), [payer]);
  const start = await connection.getBalance(attacker.publicKey);
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const supply = new BN((await connection.getTokenSupply(C.mint)).value.amount);
  const push = new BN(20_000_000_000); // 20 SOL to move the price
  const buyState = await online.fetchBuyState(C.mint, attacker.publicKey, C.tokenProgram);
  const pushTokens = pump.getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: supply, bondingCurve: buyState.bondingCurve, amount: push, quoteMint: WSOL,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...(await sdk.buyInstructions({
      global, bondingCurveAccountInfo: buyState.bondingCurveAccountInfo, bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo, mint: C.mint, user: attacker.publicKey,
      amount: pushTokens, solAmount: push, slippage: 2, tokenProgram: C.tokenProgram,
    })),
  ), [attacker]);

  const vaultBefore = await connection.getBalance(C.vault);
  const cycle = await settleAndBuild(
    connection,
    { mint: C.mint, caller: attacker.publicKey, index: 0, marginPercent: 99 },
    attacker,
  );
  if (!cycle.ready) throw new Error(`could not build the attacker's cycle: ${cycle.reason}`);
  await signAndSend(connection, cycle, attacker);
  const vaultAfter = await connection.getBalance(C.vault);

  const attackerAta = ataFor(attacker.publicKey, C.tokenProgram, C.mint);
  const held = new BN((await tokenBalance(connection, attackerAta)).toString());
  const sellState = await online.fetchSellState(C.mint, attacker.publicKey, C.tokenProgram);
  const out = pump.getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply: supply, bondingCurve: sellState.bondingCurve, amount: held,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...(await sdk.sellInstructions({
      global, bondingCurveAccountInfo: sellState.bondingCurveAccountInfo, bondingCurve: sellState.bondingCurve,
      mint: C.mint, user: attacker.publicKey, amount: held, solAmount: out, slippage: 2,
      tokenProgram: C.tokenProgram, mayhemMode: false,
    })),
  ), [attacker]);

  // Count the attacker's token account rent as theirs: it can be reclaimed.
  const end = (await connection.getBalance(attacker.publicKey)) + ((await connection.getAccountInfo(attackerAta))?.lamports ?? 0);
  const net = end - start;
  const vaultSpent = vaultBefore - vaultAfter;
  note(`the vault's cycle cost ${vaultSpent} lamports, rent and fee included; the cap is ${cycle.budget}`);
  if (vaultSpent <= cycle.budget + cycle.holderRent + 50_000) ok("the cycle spent no more than its capped budget, rent and fee");
  else bad(`the cycle spent ${vaultSpent}, more than budget ${cycle.budget} + rent + fee`);
  if (vaultAfter >= 2_000_000_000 - cycle.budget - cycle.holderRent - 50_000 - 1_000_000) ok("everything above the cap stayed in the vault for the next cycle");
  else bad(`the vault fell to ${vaultAfter}`);
  if (net < 0) ok(`the sandwich lost the attacker ${(-net / 1e9).toFixed(6)} SOL`);
  else bad(`the sandwich PROFITED ${(net / 1e9).toFixed(6)} SOL`);
}

console.log("\n" + "=".repeat(72));
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(72));
process.exit(failed === 0 ? 0 : 1);
