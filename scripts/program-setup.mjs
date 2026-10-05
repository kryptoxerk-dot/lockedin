/**
 * The mechanism program on a cluster: deploy it, set it up, give up control --
 * in the only order that cannot go wrong.
 *
 *   node --env-file=.env.mainnet scripts/program-setup.mjs --status --binary program/lockedin.so --sha256 <hex>
 *   ... --deploy --init --binary program/lockedin.so --sha256 <hex> --execute
 *   ... --verify-pda --commit <git sha> --execute
 *   ... --submit-verification
 *   ... --renounce-admin --execute
 *   ... --finalize --binary program/lockedin.so --sha256 <hex> --execute
 *
 * 1. deploy   upgradeable, max length = the exact binary, priority fee, sent
 *             through the configured RPC. Only the binary the suites tested.
 * 2. init     the program refuses init_config unless the upgrade authority
 *             signs it, so nobody can take the pause admin in between. Run in
 *             the same invocation as the deploy anyway.
 * 3. verify   writes the verified-build record (OtterSec's otter-verify PDA:
 *             repo, commit, build args) signed by the upgrade authority -- the
 *             only signer explorers trust, so it has to happen before step 6.
 *             Then asks verify.osec.io to rebuild the commit and compare.
 * 5. renounce proves the admin is ours by using it, then sets it to the zero
 *             address. Refused while paused.
 * 6. finalize removes the upgrade authority. Refused unless the deployed bytes
 *             are the tested binary, the config exists, its admin is zero, it
 *             is unpaused, and (on mainnet) OtterSec reports the build
 *             verified. After this nothing can change the program.
 *
 * Steps 5 and 6 are irreversible and need the owner's explicit go. Nothing is
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
  SystemProgram,
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
  sendAndConfirm,
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

// ------------------------------------------------------- verified build
// Mirrors solana-verify 0.5.2 (src/solana_program.rs), which does not run on
// Windows: the same program, seeds, discriminators and borsh layout, so the
// record is exactly what `solana-verify verify-from-repo` would have written.
const OTTER_VERIFY = new PublicKey("verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC");
const OTTER_INITIALIZE = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const OTTER_UPDATE = Buffer.from([219, 200, 88, 176, 158, 63, 253, 127]);
const SOLANA_VERIFY_VERSION = "0.5.2";
const REPO = option("--repo") ?? "https://github.com/kryptoxerk-dot/lockedin";
const BUILD_ARGS = ["--library-name", "lockedin"];
const VERIFY_API = "https://verify.osec.io";
const otterPda = (signer) =>
  PublicKey.findProgramAddressSync([Buffer.from("otter_verify"), signer.toBuffer(), PROGRAM.toBuffer()], OTTER_VERIFY)[0];
const borshString = (s) => {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};
/** InputParams { version, git_url, commit, args: Vec<String>, deployed_slot: u64 } */
function otterParams({ commit, deployedSlot }) {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(BUILD_ARGS.length);
  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(BigInt(deployedSlot));
  return Buffer.concat([
    borshString(SOLANA_VERIFY_VERSION),
    borshString(REPO),
    borshString(commit),
    count,
    ...BUILD_ARGS.map(borshString),
    slot,
  ]);
}
/** OtterSec's view: verified, and built from this repository. */
async function verifiedByOtterSec() {
  try {
    const response = await fetch(`${VERIFY_API}/status/${PROGRAM.toBase58()}`);
    if (!response.ok) return { verified: false, reason: `status HTTP ${response.status}` };
    const s = await response.json();
    const ours = typeof s.repo_url === "string" && s.repo_url.includes(new URL(REPO).pathname);
    const verified = s.is_verified === true && s.on_chain_hash === s.executable_hash && ours;
    return { verified, reason: verified ? `verified at commit ${s.commit}` : (s.message ?? "not verified"), status: s };
  } catch (e) {
    return { verified: false, reason: String(e.message ?? e) };
  }
}

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
  return { deployed: true, authority, slot: data.data.readBigUInt64LE(4), programBytes: data.data.subarray(PROGRAMDATA_HEADER) };
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
  const signature = await sendAndConfirm(connection, new Transaction().add(...priorityFee(), ...instructions), [wallet]);
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
          // Writes go straight to the block producers by default. Through the RPC (DEPLOY_USE_RPC=1)
          // a rate-limited provider drops most of the ~300 writes: seen with Alchemy on 2026-10-05.
          ...(process.env.DEPLOY_USE_RPC === "1" ? ["--use-rpc"] : []),
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

if (flag("--verify-pda")) {
  console.log("\n3. record the verified build");
  const commit = option("--commit");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit <full 40-character git sha of the public repo> is required");
  const state = await programState();
  if (!state.deployed) throw new Error("deploy the program first");
  if (!state.authority?.equals(wallet.publicKey)) {
    throw new Error("only the upgrade authority's record is trusted by explorers, and this wallet is not it");
  }
  const pda = otterPda(wallet.publicKey);
  const existing = await connection.getAccountInfo(pda);
  say(`repo      ${REPO}`);
  say(`commit    ${commit}`);
  say(`args      ${BUILD_ARGS.join(" ")}`);
  say(`record    ${pda.toBase58()}${existing ? " (exists; updating)" : ""}`);
  if (execute) {
    await send([new TransactionInstruction({
      programId: OTTER_VERIFY,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([existing ? OTTER_UPDATE : OTTER_INITIALIZE, otterParams({ commit, deployedSlot: state.slot })]),
    })], "verified-build record written");
    const written = await connection.getAccountInfo(pda);
    if (!written?.owner.equals(OTTER_VERIFY) || !written.data.includes(Buffer.from(commit))) {
      throw new Error("the verified-build record is missing or does not name the commit");
    }
    say("confirmed on chain: the record names this repository and commit");
  } else {
    say("would write the record; re-run with --execute");
  }
}

if (flag("--submit-verification")) {
  console.log("\n4. ask OtterSec to rebuild and compare");
  if (genesis !== MAINNET_GENESIS) throw new Error("OtterSec's verifier only serves mainnet");
  if (!(await connection.getAccountInfo(otterPda(wallet.publicKey)))) throw new Error("write the verified-build record first (--verify-pda)");
  const response = await fetch(`${VERIFY_API}/verify-with-signer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ program_id: PROGRAM.toBase58(), signer: wallet.publicKey.toBase58(), repository: "", commit_hash: "" }),
  });
  const submitted = await response.json().catch(() => ({}));
  if (!response.ok || !submitted.request_id) throw new Error(`submission refused: HTTP ${response.status} ${JSON.stringify(submitted).slice(0, 300)}`);
  say(`job ${submitted.request_id}; logs at ${VERIFY_API}/logs/${submitted.request_id}`);
  for (let waited = 0; waited < 45 * 60; waited += 15) {
    await new Promise((r) => setTimeout(r, 15_000));
    const job = await (await fetch(`${VERIFY_API}/job/${submitted.request_id}`)).json().catch(() => null);
    if (!job || job.status === "in_progress" || job.status === "unknown") continue;
    if (job.status === "completed" && job.executable_hash === job.on_chain_hash) {
      say(`verified: rebuilt hash ${job.executable_hash} equals the on-chain hash`);
      break;
    }
    throw new Error(`verification did not pass: ${JSON.stringify(job).slice(0, 400)}`);
  }
}

if (flag("--renounce-admin")) {
  console.log("\n5. renounce the pause admin  (IRREVERSIBLE)");
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
  console.log("\n6. remove the upgrade authority  (IRREVERSIBLE)");
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
    // Explorers only trust a verified-build record signed by the upgrade
    // authority, which stops existing in the next transaction. So on mainnet
    // the record must be written and OtterSec must agree before it goes.
    if (genesis === MAINNET_GENESIS && !flag("--skip-verified-build")) {
      if (!(await connection.getAccountInfo(otterPda(wallet.publicKey)))) {
        throw new Error("write the verified-build record first (--verify-pda): after this step nobody could");
      }
      const otter = await verifiedByOtterSec();
      if (!otter.verified) throw new Error(`OtterSec does not report this program verified yet (${otter.reason}); run --submit-verification`);
      say(`OtterSec: ${otter.reason}`);
    }
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
