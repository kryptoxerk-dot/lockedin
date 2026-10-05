/**
 * Launch $LOCKEDIN: one script, resumable, verified on chain at every step.
 *
 * A launch is a handful of transactions signed by one wallet, in an order that
 * matters. It is a script rather than a web page because a launch spec kept in
 * a browser's storage dies with the tab, and a tab closed between transaction
 * one and two leaves a live token with no fee routing.
 *
 * So: state on disk, every step checked against the chain before it runs, and
 * every step safe to run twice. If this dies half way, run it again.
 *
 * The order is forced by one fact -- a PDA can be derived before the account it
 * belongs to exists:
 *
 *   1. Generate the mint keypair locally. The vault ["lockv", mint] is now a
 *      known address, before the token exists.
 *   2. Create the token, with the dev buy.
 *   3. Create the fee split naming that vault, 50/50 with the deployer.
 *   4. Register the mint with our program: counter, vault rent.
 *   5. Build the lookup table, without which no cycle fits once it graduates.
 *
 *   node scripts/launch.mjs --plan                    # what it would do
 *   node scripts/launch.mjs --execute                 # do it
 *   node scripts/launch.mjs --execute --rpc http://127.0.0.1:8899
 *
 * Nothing is sent without --execute.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  PROGRAM,
  MIN_CYCLE,
  VAULT_RENT,
  WSOL,
  configPda,
  counterPda,
  disc,
  readCounter,
  vaultPda,
  buildCycle,
  confirmSuccess,
  LEGACY_TOKEN,
  initConfigInstruction,
  priorityFee,
} from "./lib/cycle.mjs";
import { ensureLookupTable, tableAddressesFor, lookupTableAddress, instructionTableAddresses } from "./lib/alt.mjs";
import { feeState, sharingConfigPda } from "./lib/fees.mjs";
import { buildFeeSplit, correctFrozenSplit } from "./lib/fee-split.mjs";
import { MAINNET_GENESIS, programPermanence } from "./lib/permanence.mjs";
import { rpcLabel } from "./lib/rpc-log.mjs";

const requireCjs = createRequire(import.meta.url);
const pump = requireCjs("@pump-fun/pump-sdk");
const BN = requireCjs("bn.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, "state");
const STATE_FILE = process.env.LAUNCH_STATE ?? path.join(STATE_DIR, "launch.json");

// ---------------------------------------------------------------- the token
// Baked into the mint for ever. There is no edit button after this.
const TOKEN = {
  name: process.env.LOCKEDIN_NAME ?? "Locked In",
  symbol: process.env.LOCKEDIN_SYMBOL ?? "LOCKEDIN",
  // Dev buy: 2 SOL, not locked, not part of the mechanism. Stated plainly
  // because implying otherwise is the kind of thing people check.
  devBuySol: Number(process.env.LOCKEDIN_DEV_BUY_SOL ?? 2),
  // Half the creator fees run the mechanism, half go to the deployer.
  vaultShareBps: Number(process.env.LOCKEDIN_VAULT_BPS ?? 5000),
};
if (TOKEN.vaultShareBps !== 5000) throw new Error("Locked In requires exactly 50% creator fees to the vault");
if (!Number.isFinite(TOKEN.devBuySol) || TOKEN.devBuySol <= 0) throw new Error("Dev buy must be a positive SOL amount");

const execute = process.argv.includes("--execute");
const rpcArg = process.argv.indexOf("--rpc");
const RPC = rpcArg >= 0 ? process.argv[rpcArg + 1] : process.env.RPC_URL ?? "http://127.0.0.1:8899";
const uriArg = process.argv.indexOf("--uri");
// --uri, then the environment, then what scripts/upload-metadata.mjs verified and recorded.
const METADATA_FILE = path.join(ROOT, "state", "metadata.json");
const METADATA_URI = uriArg >= 0
  ? process.argv[uriArg + 1]
  : process.env.LOCKEDIN_METADATA_URI ??
    (fs.existsSync(METADATA_FILE) ? JSON.parse(fs.readFileSync(METADATA_FILE, "utf8")).metadataUri : undefined);

const connection = new Connection(RPC, "confirmed");

const walletPath =
  process.env.DEPLOYER_WALLET_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
);

// ---------------------------------------------------------------- the record
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { steps: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // The mint secret key lives in here until the token exists. After creation
  // it is worthless -- pump revokes the mint authority -- but not before.
  const temporary = `${STATE_FILE}.next`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

let state = loadState();
const step = (n) => state.steps[n] ?? null;
const done = (n, value) => {
  state.steps[n] = { at: new Date().toISOString(), ...value };
  saveState(state);
};

const say = (m) => console.log(`  ${m}`);
const head = (n, title) => console.log(`\n${n}. ${title}\n${"-".repeat(72)}`);

async function send(instructions, signers, label, lookupTables = []) {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...priorityFee(), ...instructions];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  let tx;
  if (lookupTables.length) {
    tx = new VersionedTransaction(new TransactionMessage({ payerKey: deployer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message(lookupTables));
    tx.sign(signers);
  } else {
    tx = new Transaction().add(...all);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(...signers);
  }
  const raw = tx.serialize();
  if (raw.length > 1232) throw new Error(`Transaction does not fit: ${raw.length} bytes`);
  const signature = await connection.sendRawTransaction(raw);
  await confirmSuccess(connection, { signature, blockhash, lastValidBlockHeight });
  say(`${label}: ${signature}`);
  return signature;
}

console.log("=".repeat(72));
console.log(`LOCKED IN -- launch  (${execute ? "EXECUTING" : "plan only, nothing will be sent"})`);
console.log("=".repeat(72));
say(`rpc       ${rpcLabel(RPC)}`);
say(`deployer  ${deployer.publicKey.toBase58()}`);
say(`program   ${PROGRAM.toBase58()}`);
say(`state     ${STATE_FILE}`);

// ------------------------------------------------------------------ 1
head(1, "preflight");
{
  const genesis = await connection.getGenesisHash();
  if (state.genesis && state.genesis !== genesis) throw new Error("Launch state belongs to another Solana network; use a separate state file");
  if (state.creator && state.creator !== deployer.publicKey.toBase58()) throw new Error("Launch state belongs to another creator wallet");
  if (state.token && JSON.stringify(state.token) !== JSON.stringify(TOKEN)) throw new Error("Launch settings changed since this state file was created");
  state.genesis = genesis;
  state.creator = deployer.publicKey.toBase58();
  state.token = TOKEN;
  saveState(state);
  const existingMint = step("mint") ? await connection.getAccountInfo(new PublicKey(step("mint").address)) : null;
  const balance = await connection.getBalance(deployer.publicKey);
  const needed = (existingMint ? 0.03 : TOKEN.devBuySol + 0.1) * 1e9;
  say(`deployer holds ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < needed) {
    console.error(
      `\n  the deployer needs about ${(needed / 1e9).toFixed(2)} SOL ` +
        (existingMint ? "for remaining account rent and fees" : `(${TOKEN.devBuySol} for the dev buy, the rest for rent and fees)`),
    );
    process.exit(1);
  }

  const programInfo = await connection.getAccountInfo(PROGRAM);
  if (!programInfo?.executable) {
    console.error(`\n  ${PROGRAM.toBase58()} is not deployed on this cluster`);
    process.exit(1);
  }
  say("the mechanism program is deployed here");
  if (execute && state.genesis === MAINNET_GENESIS) {
    const permanent = await programPermanence(connection);
    if (permanent.immutable !== true || permanent.adminRenounced !== true || permanent.paused !== false) {
      throw new Error("Mainnet launch requires a verified immutable program and a renounced, unpaused admin. Complete the approved program setup first.");
    }
    say("verified: program immutable, pause admin renounced, cycles unpaused");
  }
}

// ------------------------------------------------------------------ 2
head(2, "the mint keypair, and the vault it implies");
// --adopt <mint>: the coin was created elsewhere (a launch desk that puts the team's buys in
// its own bundle). Accepted only if the chain shows exactly the split this script would have set:
// 50/50 between this coin's vault and this creator, frozen. Then registration and the lookup table
// continue as usual.
const adoptArg = process.argv.indexOf("--adopt");
const ADOPT = adoptArg >= 0 ? process.argv[adoptArg + 1] : null;
let mintKeypair = null;
let mint;
if (step("mint")) {
  mint = new PublicKey(step("mint").address);
  if (step("mint").secretKey) mintKeypair = Keypair.fromSecretKey(Uint8Array.from(step("mint").secretKey));
  if (ADOPT && ADOPT !== mint.toBase58()) throw new Error(`this launch state already holds coin ${mint.toBase58()}, not ${ADOPT}`);
  say(`reusing the mint from ${STATE_FILE}${step("mint").adopted ? " (adopted)" : ""}`);
} else if (ADOPT) {
  const m = new PublicKey(ADOPT);
  if (!(await connection.getAccountInfo(m))) throw new Error(`--adopt: coin ${m.toBase58()} does not exist on this cluster yet`);
  const fees = await feeState(connection, m, deployer.publicKey, { check: false });
  if (!correctFrozenSplit(fees, vaultPda(m), deployer.publicKey)) {
    throw new Error(`--adopt: ${m.toBase58()} does not carry the frozen 50/50 split between its Locked In vault and ${deployer.publicKey.toBase58()}; refusing it`);
  }
  done("mint", { address: m.toBase58(), adopted: true });
  done("create", { mint: m.toBase58(), adopted: true });
  mint = m;
  say(`adopted ${m.toBase58()}: created elsewhere, frozen 50/50 split verified on chain`);
} else {
  mintKeypair = Keypair.generate();
  done("mint", {
    address: mintKeypair.publicKey.toBase58(),
    secretKey: Array.from(mintKeypair.secretKey),
  });
  say("generated a new mint keypair");
  mint = mintKeypair.publicKey;
}
const vault = vaultPda(mint);
say(`mint      ${mint.toBase58()}`);
say(`vault     ${vault.toBase58()}   <- half the creator fees arrive here`);
say(`counter   ${counterPda(mint).toBase58()}`);

// ------------------------------------------------------------------ 3
head(3, "metadata");
let uri = step("metadata")?.uri ?? METADATA_URI;
if (!uri && step("mint")?.adopted) uri = "(set by the launch desk that created the coin)";
if (!uri) {
  console.error(
    "\n  No metadata URI. Run scripts/upload-metadata.mjs first (it records the\n" +
      "  URI for this script), or pass one:  --uri https://ipfs.io/ipfs/...\n" +
      "\n  This is deliberately a separate step: the image, the description and\n" +
      "  the socials are baked into the mint for ever, and should be looked at\n" +
      "  by a person before they are.",
  );
  process.exit(1);
}
say(`uri       ${uri}`);
if (!step("metadata")) done("metadata", { uri });

// ------------------------------------------------------------------ 4
head(4, `create the token, with a ${TOKEN.devBuySol} SOL dev buy`);
{
  const existing = await connection.getAccountInfo(mint);
  if (existing) {
    say("the mint already exists; nothing to create");
  } else if (!execute) {
    say(`would create "${TOKEN.name}" ($${TOKEN.symbol}) and buy ${TOKEN.devBuySol} SOL of it`);
  } else {
    const sdk = new pump.PumpSdk();
    const online = new pump.OnlinePumpSdk(connection);
    const global = await online.fetchGlobal();
    const feeConfig = await online.fetchFeeConfig();
    const solAmount = new BN(Math.round(TOKEN.devBuySol * 1e9));

    // How many tokens that SOL buys on a curve that does not exist yet. The
    // curve's opening state is deterministic, so this is exact rather than a
    // quote against something live.
    const openingCurve = pump.newBondingCurve(global, WSOL);
    openingCurve.creator = sharingConfigPda(mint);
    openingCurve.isMayhemMode = false;
    const amount = pump.getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: global.tokenTotalSupply,
      bondingCurve: openingCurve,
      amount: solAmount,
      quoteMint: WSOL,
    });

    // Create + frozen fee routing + dev buy in one transaction. The buy uses
    // the sharing-config creator, so even its own fee is split 50/50.
    const create = await sdk.createV2Instruction({
      mint, name: TOKEN.name, symbol: TOKEN.symbol, uri,
      creator: deployer.publicKey, user: deployer.publicKey,
      mayhemMode: false, cashback: false,
    });
    const split = await buildFeeSplit(connection, mint, deployer.publicKey);
    const buy = await sdk.buyInstructions({
      global, bondingCurveAccountInfo: null, bondingCurve: openingCurve,
      associatedUserAccountInfo: null, mint, user: deployer.publicKey,
      amount, solAmount, slippage: 1,
      tokenProgram: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    });
    const instructions = [create, ...split.instructions, ...buy];
    const { table } = await ensureLookupTable(connection, deployer, mint,
      instructionTableAddresses(instructions, [deployer.publicKey, mint]), say);
    const signature = await send(instructions, [deployer, mintKeypair], "created, fee shares frozen, dev buy complete", [table]);
    done("create", { signature, mint: mint.toBase58(), atomicFeeRouting: true, devBuySol: TOKEN.devBuySol });
  }
}

// ------------------------------------------------------------------ 5
head(5, "the fee split: half to the mechanism, half to the deployer");
{
  const { instructions, before } = await buildFeeSplit(connection, mint, deployer.publicKey);
  if (!instructions.length) {
    say("verified: frozen 50/50 split already configured");
  } else if (!execute) {
    say(`would configure ${sharingConfigPda(mint).toBase58()} atomically, including before graduation`);
    say(`  5000 bps  ${vault.toBase58()}`);
    say(`  5000 bps  ${deployer.publicKey.toBase58()}`);
    say("the share update permanently revokes the fee-config admin");
  } else {
    const signature = await send(instructions, [deployer], "50/50 shares configured and frozen");
    const after = await feeState(connection, mint, deployer.publicKey, { check: false });
    if (!correctFrozenSplit(after, vault, deployer.publicKey)) {
      throw new Error(`Fee split verification failed: ${JSON.stringify(after.shareholders)}, editable=${after.editable}`);
    }
    say("confirmed on chain: exactly 50% to each recipient; share configuration frozen");
    done("split", { signature, shareholders: after.shareholders, editable: after.editable });
  }
}

// ------------------------------------------------------------------ 6
head(6, "register the mint with the mechanism");
{
  const config = configPda();
  if (!(await connection.getAccountInfo(config))) {
    if (!execute) {
      say(`would initialise the program config ${config.toBase58()}`);
    } else {
      // Only works while the deployer is still the upgrade authority.
      await send([initConfigInstruction(deployer.publicKey)], [deployer], "config initialised");
    }
  } else {
    say("the program config already exists");
  }

  const counter = await readCounter(connection, mint);
  if (counter) {
    say(`already registered: ${counter.totalHolders} holders, next index ${counter.nextIndex}`);
  } else if (!execute) {
    say(`would create the counter and fund the vault's ${VAULT_RENT} lamports of rent`);
  } else {
    const signature = await send(
      [
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: counterPda(mint), isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc("init_token"),
        }),
      ],
      [deployer],
      "registered",
    );
    done("register", { signature });
  }
}

// ------------------------------------------------------------------ 7
head(7, "the lookup table");
{
  // Without this a cycle fits while the token is on the bonding curve and
  // stops fitting the moment it graduates -- 33 accounts is two bytes over a
  // legacy transaction. Built now, not on the day it is first needed.
  const recorded = lookupTableAddress(mint);
  if (!execute) {
    say(recorded ? `table ${recorded.toBase58()} already recorded` : "would build the lookup table");
    say("(needs the token to exist, so it runs after creation)");
  } else {
    const built = await buildCycle(connection, {
      mint,
      caller: deployer.publicKey,
      index: 0,
      marginPercent: 92,
      budgetOverride: MIN_CYCLE * 4,
    });
    if (!built.ready) {
      say(`could not read the account list yet: ${built.reason}`);
      say("run scripts/make-alt.mjs once the market exists");
    } else {
      const { address, table } = await ensureLookupTable(
        connection,
        deployer,
        mint,
        tableAddressesFor(built, {
          payer: deployer.publicKey,
          program: PROGRAM,
          computeBudget: ComputeBudgetProgram.programId,
        }),
        (m) => say(m),
      );
      say(`table ${address.toBase58()}, ${table.state.addresses.length} accounts`);
      done("alt", { address: address.toBase58() });
    }
  }
}

// ------------------------------------------------------------------ 8
head(8, "what exists now");
{
  const counter = await readCounter(connection, mint);
  const fees = await feeState(connection, mint, deployer.publicKey, { check: false });
  say(`mint            ${mint.toBase58()}`);
  say(`vault           ${vault.toBase58()}`);
  say(`vault balance   ${await connection.getBalance(vault)} lamports`);
  say(`registered      ${counter ? "yes" : "no"}`);
  say(`fee split       ${fees.exists ? `${fees.shareholders.length} shareholders` : "not set"}`);
  for (const s of fees.shareholders) {
    say(`   ${String(s.shareBps).padStart(5)} bps  ${s.address}` +
      (s.address === vault.toBase58() ? "  <- mechanism" : ""));
  }
  say(`lookup table    ${lookupTableAddress(mint)?.toBase58() ?? "none"}`);

  if (execute) {
    console.log("\n  Next:");
    console.log(`    LOCKEDIN_MINT=${mint.toBase58()} node scripts/keeper.mjs --once`);
    console.log("    then the same with --execute, then as a service.");
  } else {
    console.log("\n  Nothing was sent. Re-run with --execute to do it.");
  }
}
console.log("");
