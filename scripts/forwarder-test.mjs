/**
 * The forwarder sends fees and only fees. Read-only: replays the live coin's
 * history from mainnet, then feeds the same code hostile and edge-case input.
 *
 *   RPC_URL=<mainnet rpc> LOCKEDIN_MINT=<mint> CREATOR_ADDRESS=<creator> node scripts/forwarder-test.mjs
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { vaultPda } from "./lib/cycle.mjs";
import { classifyTransaction, transferAmount } from "./lib/forwarding.mjs";

const connection = new Connection(process.env.RPC_URL, "confirmed");
const mint = new PublicKey(process.env.LOCKEDIN_MINT);
const vault = vaultPda(mint).toBase58();
const creator = process.env.CREATOR_ADDRESS;
const SOL = 1_000_000_000n;

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`);
  ok ? passed++ : failed++;
};

// 1. Real history: every vault transaction since launch.
const sigs = [];
let before;
for (;;) {
  const page = await connection.getSignaturesForAddress(new PublicKey(vault), { before, limit: 1000 });
  sigs.push(...page);
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}
const txs = [];
for (const s of sigs.reverse()) {
  txs.push(await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }));
}
let owed = 0n, distributions = 0, others = 0, othersOwed = 0n, independent = 0n;
for (const tx of txs) {
  const r = classifyTransaction(tx, vault, creator);
  const isDistribute = !tx.meta.err && tx.meta.logMessages.some((l) => l === "Program log: Instruction: DistributeCreatorFees");
  if (isDistribute) {
    distributions++;
    owed += r.owed;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const i = keys.indexOf(creator);
    independent += BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) + (i === 0 ? BigInt(tx.meta.fee) : 0n);
  } else {
    others++;
    othersOwed += r.owed;
  }
}
check(`real history: owed equals what the creator received, over ${distributions} distributions`, owed === independent, `${owed} vs ${independent} lamports`);
check(`real history: ${others} non-distribution transactions (cycles, setup) owe nothing`, othersOwed === 0n);

// 2. Hostile input, built from a real distribution.
const real = txs.find((tx) => classifyTransaction(tx, vault, creator).owed > 0n);
const share = classifyTransaction(real, vault, creator).owed;
const mutate = (fn) => { const t = structuredClone({ ...real, transaction: { ...real.transaction, message: { ...real.transaction.message, accountKeys: real.transaction.message.accountKeys.map((k) => ({ ...k, pubkey: k.pubkey.toBase58() })), instructions: real.transaction.message.instructions.map((ix) => ({ ...ix, programId: String(ix.programId) })) } } }); t.meta.innerInstructions = []; fn(t); return t; };
const at = (t, a) => t.transaction.message.accountKeys.findIndex((k) => k.pubkey === a);

const tipCreator = mutate((t) => { t.meta.postBalances[at(t, creator)] += 5 * Number(SOL); });
check("5 SOL sent to the creator inside a distribution is not owed", classifyTransaction(tipCreator, vault, creator).owed === share);
const tipVault = mutate((t) => { t.meta.postBalances[at(t, vault)] += 5 * Number(SOL); });
check("5 SOL sent to the vault inside a distribution does not raise what is owed", classifyTransaction(tipVault, vault, creator).owed === share);
const fakeLog = mutate((t) => {
  t.transaction.message.instructions = t.transaction.message.instructions.filter((ix) => ix.programId !== "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  t.meta.postBalances[at(t, creator)] += 5 * Number(SOL);
  t.meta.postBalances[at(t, vault)] += 5 * Number(SOL);
});
check("a transaction that only logs \"DistributeCreatorFees\" owes nothing", classifyTransaction(fakeLog, vault, creator).owed === 0n);
// Net of its own transaction fee, which is added back when the creator paid it.
const creatorLoses = mutate((t) => { t.meta.postBalances[at(t, creator)] = t.meta.preBalances[at(t, creator)] - t.meta.fee - 1000; });
check("a distribution the creator gained nothing from owes nothing", classifyTransaction(creatorLoses, vault, creator).owed === 0n);
const failedTx = mutate((t) => { t.meta.err = { InstructionError: [0, "Custom"] }; });
check("a failed transaction owes nothing", classifyTransaction(failedTx, vault, creator).owed === 0n);

// 3. How much one tick sends.
const limits = { min: 5_000_000n, reserve: 10_000_000n, max: SOL };
check("owes 0.03 SOL with 50 SOL in the wallet: sends 0.03, not the balance", transferAmount(30_000_000n, 50n * SOL, limits) === 30_000_000n);
check("owes 5 SOL: sends at most 1 SOL this tick", transferAmount(5n * SOL, 100n * SOL, limits) === SOL);
check("owes 0.03 SOL with 0.035 in the wallet: keeps the 0.01 reserve", transferAmount(30_000_000n, 35_000_000n, limits) === 25_000_000n);
check("owes 0.003 SOL: below the minimum, sends nothing", transferAmount(3_000_000n, 50n * SOL, limits) === 0n);
check("wallet below its reserve: sends nothing", transferAmount(30_000_000n, 9_000_000n, limits) === 0n);
check("owes nothing: sends nothing", transferAmount(0n, 50n * SOL, limits) === 0n);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
