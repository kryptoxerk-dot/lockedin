/**
 * The mechanism program on a cluster: deploy it, set it up, give up control --
 * in the only order that cannot go wrong.
 *
 *   node --env-file=.env.mainnet scripts/program-setup.mjs --status --binary program/lockedin.so --sha256 <hex>
 *   ... --deploy --init --binary program/lockedin.so --sha256 <hex> --execute
 *   ... --renounce-admin --execute
 *   ... --finalize --binary program/lockedin.so --sha256 <hex> --execute
 *
 * 1. deploy   upgradeable, max length = the exact binary, priority fee, sent
 *             through the configured RPC. Only the binary the suites tested.
 * 2. init     the program refuses init_config unless the upgrade authority
 *             signs it, so nobody can take the pause admin in between. Run in
 *             the same invocation as the deploy anyway.
 * 3. renounce proves the admin is ours by using it, then sets it to the zero
 *             address. Refused while paused.
 * 4. finalize removes the upgrade authority. Refused unless the deployed bytes
 *             are the tested binary, the config exists, its admin is zero and
 *             it is unpaused. After this nothing can change the program.
 *
 * Steps 3 and 4 are irreversible and need the owner's explicit go. Nothing is
 * sent without --execute. The RPC URL is read from RPC_URL and handed to the
 * Solana CLI through a private config file, never as a command argument.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  PROGRAM,
  BPF_LOADER_UPGRADEABLE,
  PRIORITY_MICROLAMPORTS,
  configPda,
  disc,
  initConfigInstruction,
  priorityFee,
  programDataPda,
} from "./lib/cycle.mjs";
import { MAINNET_GENESIS, programPermanence } from "./lib/permanence.mjs";
import { rpcLabel } from "./lib/rpc-log.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const execute = flag("--execute");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");
const walletPath =
  process.env.DEPLOYER_WALLET_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM_KEYPAIR = option("--program-keypair") ?? path.join(ROOT, ".keys", "program.json");

const say = (m) => console.log(`  ${m}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PROGRAMDATA_HEADER = 45; // u32 tag, u64 slot, Option<Pubkey>

// ------------------------------------------------------------- the binary
function loadBinary() {
  const file = option("--binary");
  const expected = option("--sha256")?.toLowerCase();
  if (!file || !expected) throw new Error("--binary <file> and --sha256 <hex> are both required for this step");
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`binary hash ${actual} is not the tested ${expected}`);
  return { file, bytes, sha: actual };
}

// ------------------------------------------------------------- the chain
async function programState() {
  const program = await connection.getAccountInfo(PROGRAM);
  if (!program) return { deployed: false };
  if (!program.owner.equals(BPF_LOADER_UPGRADEABLE) || program.data.readUInt32LE(0) !== 2) {
    throw new Error(`${PROGRAM.toBase58()} exists but is not an upgradeable program`);
  }
  const dataAddress = new PublicKey(program.data.subarray(4, 36));
  if (!dataAddress.equals(programDataPda())) throw new Error("unexpected ProgramData address");
  const data = await connection.getAccountInfo(dataAddress);
  if (!data || data.data.readUInt32LE(0) !== 3) throw new Error("ProgramData account missing or malformed");
  const authority = data.data[12] === 1 ? new PublicKey(data.data.subarray(13, 45)) : null;
  return { deployed: true, authority, programBytes: data.data.subarray(PROGRAMDATA_HEADER) };
}

async function configState() {
  const info = await connection.getAccountInfo(configPda());
  if (!info) return null;
  if (!info.owner.equals(PROGRAM) || info.data.length < 42) throw new Error("invalid program config account");
  const admin = new PublicKey(info.data.subarray(8, 40));
  return { admin, renounced: admin.equals(PublicKey.default), paused: info.data[40] !== 0 };
}

/** Deployed bytes equal the tested binary, and whatever follows is zero padding. */
function deployedMatches(state, binary) {
  const head = state.programBytes.subarray(0, binary.bytes.length);
  const tail = state.programBytes.subarray(binary.bytes.length);
  return sha256(head) === binary.sha && tail.every((b) => b === 0);
}

async function send(instructions, label) {
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...priorityFee(), ...instructions),
    [wallet],
    { commitment: "confirmed" },
  );
  say(`${label}: ${signature}`);
  return signature;
}

// ------------------------------------------------------------- run
const genesis = await connection.getGenesisHash();
console.log("=".repeat(72));
console.log(`LOCKED IN -- program setup  (${execute ? "EXECUTING" : "read-only"})`);
console.log("=".repeat(72));
say(`rpc       ${rpcLabel(RPC)}${genesis === MAINNET_GENESIS ? "  (mainnet)" : ""}`);
say(`wallet    ${wallet.publicKey.toBase58()}`);
say(`program   ${PROGRAM.toBase58()}`);
say(`balance   ${(await connection.getBalance(wallet.publicKey)) / 1e9} SOL`);

if (flag("--deploy")) {
  console.log("\n1. deploy");
  const programKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PROGRAM_KEYPAIR, "utf8"))));
  if (!programKey.publicKey.equals(PROGRAM)) throw new Error(`${PROGRAM_KEYPAIR} is not the program keypair`);
  const binary = loadBinary();
  const existing = await programState();
  if (existing.deployed) {
    if (!deployedMatches(existing, binary)) throw new Error("a different binary is already deployed at this address");
    say("already deployed, and the bytes match the tested binary");
  } else {
    const rent = await connection.getMinimumBalanceForRentExemption(PROGRAMDATA_HEADER + binary.bytes.length);
    const buffer = await connection.getMinimumBalanceForRentExemption(37 + binary.bytes.length);
    const programRent = await connection.getMinimumBalanceForRentExemption(36);
    const needed = rent + buffer + programRent + 20_000_000;
    say(`${binary.bytes.length} bytes, sha256 ${binary.sha}`);
    say(`needs ${(needed / 1e9).toFixed(4)} SOL now; ${(buffer / 1e9).toFixed(4)} of it returns when the deploy completes`);
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < needed) throw new Error(`wallet holds ${(balance / 1e9).toFixed(4)} SOL; fund it first`);
    if (!execute) {
      say("would deploy; re-run with --execute");
    } else {
      // The CLI takes its RPC from a config file we write and delete, so the
      // provider's key never appears in a process listing or shell history.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockedin-cli-"));
      const configFile = path.join(dir, "config.yml");
      fs.writeFileSync(configFile, `json_rpc_url: "${RPC}"\nwebsocket_url: ""\nkeypair_path: "${walletPath.replaceAll("\\", "/")}"\ncommitment: confirmed\n`, { mode: 0o600 });
      try {
        const cli = process.env.SOLANA_CLI ?? "solana";
        const result = spawnSync(cli, [
          "--config", configFile,
          "program", "deploy", binary.file,
          "--program-id", PROGRAM_KEYPAIR,
          "--max-len", String(binary.bytes.length),
          "--with-compute-unit-price", String(PRIORITY_MICROLAMPORTS),
          "--max-sign-attempts", "50",
          "--use-rpc",
        ], { stdio: "inherit" });
        if (result.status !== 0) {
          throw new Error("solana program deploy failed. If it left a buffer, reclaim it with `solana program close --buffers`.");
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const deployed = await programState();
      if (!deployed.deployed || !deployedMatches(deployed, binary)) throw new Error("deployed bytes do not match the tested binary");
      say("deployed; on-chain bytes match the tested binary");
    }
  }
}

if (flag("--init")) {
  console.log("\n2. init the config");
  const state = await programState();
  if (!state.deployed) throw new Error("deploy the program first");
  const config = await configState();
  if (config) {
    say(`config exists; admin ${config.admin.toBase58()}`);
  } else {
    if (!state.authority?.equals(wallet.publicKey)) throw new Error("only the upgrade authority can initialise the config");
    if (execute) {
      // A program deployed in one slot cannot be called until a later one, so
      // straight after the deploy the first attempt can fail for that alone.
      const deployedAt = await connection.getSlot("confirmed");
      while ((await connection.getSlot("confirmed")) < deployedAt + 2) await new Promise((r) => setTimeout(r, 400));
      for (let attempt = 1; ; attempt++) {
        try {
          await send([initConfigInstruction(wallet.publicKey)], "config initialised");
          break;
        } catch (e) {
          if (attempt === 4 || (await configState())) throw e;
          say(`init attempt ${attempt} failed (${String(e.message ?? e).split("\n")[0].slice(0, 120)}); retrying`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } else {
      say(`would initialise with admin ${wallet.publicKey.toBase58()}`);
    }
  }
}

if (flag("--renounce-admin")) {
  console.log("\n3. renounce the pause admin  (IRREVERSIBLE)");
  const config = await configState();
  if (!config) throw new Error("initialise the config first");
  if (config.renounced) {
    say("already renounced");
  } else {
    if (config.paused) throw new Error("refusing to renounce while cycles are paused");
    if (!config.admin.equals(wallet.publicKey)) throw new Error(`the admin is ${config.admin.toBase58()}, not this wallet`);
    if (execute) {
      await send([new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
          { pubkey: configPda(), isSigner: false, isWritable: true },
        ],
        data: disc("renounce_admin"),
      })], "admin renounced");
    } else {
      say("would set the admin to the zero address; re-run with --execute");
    }
  }
}

if (flag("--finalize")) {
  console.log("\n4. remove the upgrade authority  (IRREVERSIBLE)");
  const binary = loadBinary();
  const state = await programState();
  if (!state.deployed) throw new Error("deploy the program first");
  if (!state.authority) {
    say("already immutable");
  } else {
    if (!deployedMatches(state, binary)) throw new Error("deployed bytes are not the tested binary");
    const config = await configState();
    if (!config) throw new Error("initialise the config before finalising: afterwards nobody could");
    if (!config.renounced) throw new Error("renounce the pause admin before finalising");
    if (config.paused) throw new Error("the config is paused");
    if (!state.authority.equals(wallet.publicKey)) throw new Error(`the upgrade authority is ${state.authority.toBase58()}, not this wallet`);
    if (execute) {
      // Loader-v3 SetAuthority with no new authority: the program is final.
      await send([new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE,
        keys: [
          { pubkey: programDataPda(), isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([4, 0, 0, 0]),
      })], "upgrade authority removed");
    } else {
      say("would remove the upgrade authority; re-run with --execute");
    }
  }
}

console.log("\nstatus");
const state = await programState();
const config = state.deployed ? await configState() : null;
const permanence = await programPermanence(connection);
const binaryCheck = option("--binary") && option("--sha256") && state.deployed ? deployedMatches(state, loadBinary()) : null;
console.log(JSON.stringify({
  program: PROGRAM.toBase58(),
  mainnet: genesis === MAINNET_GENESIS,
  deployed: state.deployed,
  upgradeAuthority: state.authority?.toBase58() ?? null,
  matchesTestedBinary: binaryCheck,
  config: config ? { admin: config.admin.toBase58(), renounced: config.renounced, paused: config.paused } : null,
  ...permanence,
  mode: execute ? "executing" : "read-only",
}, null, 2));
