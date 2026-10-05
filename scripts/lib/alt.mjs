/**
 * The address lookup table a PumpSwap cycle needs to fit in a transaction.
 *
 * A cycle on the AMM names 33 distinct accounts. As raw keys that is 1056
 * bytes, which puts a legacy transaction two bytes past the 1232-byte limit --
 * so the token would work for the few hours it spends on the bonding curve and
 * then quietly stop working forever. A lookup table replaces each of those
 * keys with a one-byte index and leaves roughly 800 bytes of headroom.
 *
 * The table is not a trust boundary. Entries can only be appended, never
 * rewritten, and the program re-derives and checks every account that matters
 * on chain, so a table that lied would be rejected rather than obeyed. That is
 * why it is left unfrozen: pump can add a fee recipient, and we need to be
 * able to follow.
 */
import {
  AddressLookupTableProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import { priorityFee, sendAndConfirm } from "./cycle.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE = path.join(ROOT, "state");

export const altPathFor = (mint) => path.join(STATE, `alt-${mint.toBase58()}.json`);

/** Remember which table serves a mint, so the keeper does not have to be told. */
export function recordLookupTable(mint, address) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    altPathFor(mint),
    `${JSON.stringify({ mint: mint.toBase58(), lookupTable: address.toBase58() }, null, 2)}\n`,
  );
}

/** The table's address, from the environment or from what make-alt recorded. */
export function lookupTableAddress(mint) {
  if (process.env.LOCKEDIN_ALT) return new PublicKey(process.env.LOCKEDIN_ALT);
  const file = altPathFor(mint);
  if (!fs.existsSync(file)) return null;
  return new PublicKey(JSON.parse(fs.readFileSync(file, "utf8")).lookupTable);
}

/**
 * The table, ready to compile against, or null with a reason.
 *
 * A table is unusable in the same slot it was extended in, and the failure is
 * an unhelpful "invalid transaction" rather than anything naming the table --
 * so that case is reported here instead of at send time.
 */
export async function loadLookupTable(connection, mint) {
  const address = lookupTableAddress(mint);
  if (!address) return { table: null, reason: "no lookup table recorded; run scripts/make-alt.mjs" };

  const res = await connection.getAddressLookupTable(address);
  if (!res.value) return { table: null, reason: `lookup table ${address.toBase58()} does not exist` };

  const slot = await connection.getSlot();
  const extended = Number(res.value.state.lastExtendedSlot);
  if (extended >= slot) {
    return { table: null, reason: `lookup table extended in slot ${extended}, not usable until ${extended + 1}` };
  }
  if (res.value.state.deactivationSlot !== 2n ** 64n - 1n) {
    return { table: null, reason: "lookup table is deactivating" };
  }
  return { table: res.value, address, reason: null };
}

/**
 * Create the table if it is missing, append whatever it lacks, wait until it
 * can be used, and hand it back. Re-running changes nothing.
 *
 * Shared by the launch script and the tests so that what is proven here is the
 * table the token actually launches with.
 */
export async function ensureLookupTable(connection, payer, mint, addresses, log = () => {}) {
  let address = lookupTableAddress(mint);
  let existing = [];

  if (address) {
    const res = await connection.getAddressLookupTable(address);
    if (res.value) {
      existing = res.value.state.addresses.map((a) => a.toBase58());
      log(`table ${address.toBase58()} exists with ${existing.length} entries`);
    } else {
      log(`table ${address.toBase58()} was recorded but is not on this cluster; making a new one`);
      address = null;
    }
  }

  if (!address) {
    // Finalized: createLookupTable rejects a slot the cluster has not settled
    // on, and a merely confirmed slot can still be rolled back.
    const recentSlot = await connection.getSlot("finalized");
    const [ix, created] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
    await sendAndConfirm(connection, new Transaction().add(...priorityFee(), ix), [payer]);
    address = created;
    recordLookupTable(mint, address);
    log(`table ${address.toBase58()} created`);
  }

  const missing = addresses.filter((a) => !existing.includes(a.toBase58()));
  // Twenty at a time: thirty addresses is 960 bytes and an extend transaction
  // has its own overhead on top, which lands close enough to the limit to be
  // worth not discovering in production.
  for (let n = 0; n < missing.length; n += 20) {
    const chunk = missing.slice(n, n + 20);
    await sendAndConfirm(
      connection,
      new Transaction().add(
        ...priorityFee(),
        AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: address,
          addresses: chunk,
        }),
      ),
      [payer],
    );
    log(`extended with ${chunk.length}`);
  }

  if (missing.length) {
    // A table cannot be used in the slot it was extended in, and the failure
    // when you try names neither the table nor the slot.
    const start = await connection.getSlot();
    while ((await connection.getSlot()) <= start + 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const res = await connection.getAddressLookupTable(address);
  return { address, table: res.value, added: missing.length };
}

/**
 * Which of a cycle's accounts belong in the table.
 *
 * Signers and the program IDs of top-level instructions have to stay static
 * keys, and the holder pair is different every cycle -- a table holding those
 * would grow forever and save nothing.
 */
export function tableAddressesFor(built, { payer, program, computeBudget }) {
  const skip = new Set([
    payer.toBase58(),
    program.toBase58(),
    computeBudget.toBase58(),
    built.holder.toBase58(),
    built.holderAta.toBase58(),
  ]);
  const seen = new Set();
  const out = [];
  for (const k of built.instruction.keys) {
    const s = k.pubkey.toBase58();
    if (skip.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(k.pubkey);
  }
  return out;
}

/** Lookup candidates for a multi-instruction launch; signers/programs stay static. */
export function instructionTableAddresses(instructions, signers = []) {
  const skip = new Set([...signers, ...instructions.map(ix => ix.programId)].map(key => key.toBase58()));
  const seen = new Set();
  const result = [];
  for (const ix of instructions) for (const meta of ix.keys) {
    const address = meta.pubkey.toBase58();
    if (meta.isSigner || skip.has(address) || seen.has(address)) continue;
    seen.add(address);
    result.push(meta.pubkey);
  }
  return result;
}
