/**
 * The forwarder's arithmetic, kept apart from its I/O so it can be tested on
 * real and hostile transactions alike. See scripts/forward-creator-share.mjs.
 */
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DISTRIBUTE = Buffer.from([165, 114, 103, 0, 121, 206, 247, 81]);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const d = B58.indexOf(ch);
    if (d < 0) return Buffer.alloc(0);
    n = n * 58n + BigInt(d);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** Top-level and inner instructions alike. */
function allInstructions(tx) {
  return [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
}

/**
 * What one parsed vault transaction means for the ledger: { owed, forwarded }.
 *
 * Only fees count as owed, and only fees the creator actually received:
 *   - the transaction must call pump's DistributeCreatorFees itself (checked by
 *     program and instruction bytes, not by a log line any program could print);
 *   - the amount is the smaller of the vault's gain and the creator's gain (its
 *     transaction fee added back when it paid one). Extra SOL sent to either
 *     wallet in the same transaction can therefore never raise it: with the 50/50
 *     split the two halves are equal, and anything above that is not a fee.
 * The creator's other SOL -- its balance, its dev-buy proceeds, anything sent to
 * it outside a distribution -- is never owed and never sent.
 */
export function classifyTransaction(tx, vault, creator) {
  if (tx.meta?.err) return { owed: 0n, forwarded: 0n };
  const keys = tx.transaction.message.accountKeys.map((k) => String(k.pubkey ?? k));
  const gain = (address) => {
    const i = keys.indexOf(address);
    return i < 0 ? 0n : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
  };
  const instructions = allInstructions(tx);

  let owed = 0n;
  const distributes = instructions.some((ix) =>
    String(ix.programId) === PUMP && typeof ix.data === "string" && b58decode(ix.data).subarray(0, 8).equals(DISTRIBUTE));
  if (distributes) {
    const vaultGain = gain(vault);
    const creatorGain = gain(creator) + (keys[0] === creator ? BigInt(tx.meta.fee) : 0n);
    const share = vaultGain < creatorGain ? vaultGain : creatorGain;
    if (share > 0n) owed = share;
  }

  // Counted wherever they appear, so a forward can never be missed and sent twice.
  let forwarded = 0n;
  for (const ix of instructions) {
    const p = ix.parsed;
    if (ix.program === "system" && p?.type === "transfer" && p.info.source === creator && p.info.destination === vault) {
      forwarded += BigInt(p.info.lamports);
    }
  }
  return { owed, forwarded };
}

/**
 * How much to send this tick: what is owed and not yet forwarded, never more
 * than the creator can spare above its reserve, never more than the per-transfer
 * cap (the rest goes next tick), and nothing when that is below the minimum.
 */
export function transferAmount(due, balance, { min, reserve, max }) {
  let amount = due;
  if (amount > balance - reserve) amount = balance - reserve;
  if (amount > max) amount = max;
  return amount >= min ? amount : 0n;
}
