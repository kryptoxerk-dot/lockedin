/**
 * Getting the creator fees out of pump and into the vault.
 *
 * This is the step that makes the mechanism move, and it is easy to get
 * silently wrong. Creator fees do not arrive anywhere by themselves. They
 * accumulate in pump-owned vaults -- one on the bonding curve, another on the
 * AMM after graduation -- and stay there until somebody sends a transaction.
 * Only then does the fee sharing config split them among shareholders, of
 * which our vault is one.
 *
 * Every number here comes from pump's own answer to "what could be distributed
 * right now", which it computes by simulating its own instructions across both
 * vaults. An earlier version added balances up by hand and had three separate
 * bugs, each of which made the keeper report "nothing to distribute" for ever on
 * a token earning normally:
 *
 *   - buildDistributeCreatorFeesInstructions returns { instructions,
 *     isGraduated }, not an array. `.length` on the object is undefined, so
 *     every call looked empty. This one alone would have stopped every
 *     buyback after graduation.
 *   - It read only the bonding-curve vault, which is empty after graduation.
 *   - It called the online minimum check with no mint. That threw, the catch
 *     swallowed it, and the "minimum" was always zero.
 *
 * The other half of the split goes to the deployer in the same transaction, by
 * the same instruction. Nobody has to be trusted to forward anything.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const pump = requireCjs("@pump-fun/pump-sdk");

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

/** Where a mint's fee split lives. Derived from the mint, so knowable early. */
export const sharingConfigPda = (mint) => pump.feeSharingConfigPda(mint);

const big = (bn) => BigInt(bn?.toString?.() ?? 0);

/**
 * What pump is holding for this token, who it is owed to, and whether it can
 * be paid out now.
 *
 * `simulator` must be an account that exists and holds SOL on this cluster:
 * pump's check simulates a transaction with it as fee payer. Left to the SDK it
 * defaults to a fixed third-party mainnet address, and if that account were
 * ever emptied the check would quietly return "cannot distribute" for good.
 * Pass the keeper.
 */
export async function feeState(connection, mint, simulator, { check = true } = {}) {
  const sdk = new pump.PumpSdk();
  const online = new pump.OnlinePumpSdk(connection);

  const configAddress = sharingConfigPda(mint);
  const configInfo = await connection.getAccountInfo(configAddress);

  const state = {
    mint: mint.toBase58(),
    configAddress,
    exists: Boolean(configInfo),
    editable: null,
    shareholders: [],
    graduated: null,
    distributableLamports: 0n,
    minimumLamports: 0n,
    canDistribute: false,
    checkError: null,
  };
  if (!configInfo) return state;
  if (!configInfo.owner.equals(pump.PUMP_FEE_PROGRAM_ID)) throw new Error("Fee configuration is not owned by the Pump fee program");

  // The whole account, not its data: decodeSharingConfig reaches for `.data`
  // itself, and handing it the bytes fails several frames down in anchor's
  // coder with nothing naming this call.
  const sharingConfig = sdk.decodeSharingConfig(configInfo);
  state.shareholders = (sharingConfig.shareholders ?? []).map((s) => ({
    address: s.address.toBase58(),
    shareBps: Number(s.shareBps ?? s.share ?? 0),
  }));
  try {
    state.editable = pump.isSharingConfigEditable({ sharingConfig });
  } catch { /* older layouts */ }

  // Callers that only want the shareholder list skip pump's simulation: the
  // dashboard reads this every thirty seconds and has no use for it.
  if (!check) return state;

  try {
    const min = await online.getMinimumDistributableFee(
      mint,
      simulator ?? undefined,
      { quoteMint: WSOL },
    );
    state.graduated = Boolean(min.isGraduated);
    state.distributableLamports = big(min.distributableFees);
    state.minimumLamports = big(min.minimumRequired);
    state.canDistribute = Boolean(min.canDistribute);
  } catch (e) {
    // Reported, not swallowed. A check that fails and reads as "nothing to do"
    // is the exact failure this file used to have.
    state.checkError = String(e.message).split("\n")[0].slice(0, 200);
  }
  return state;
}

/**
 * The instructions that collect and distribute, or a reason there are none.
 *
 * Returning a reason rather than throwing matters: the keeper runs this every
 * tick and "nothing has accumulated yet" is the normal case, not an error.
 */
export async function distributeInstructions(connection, mint, payer) {
  const online = new pump.OnlinePumpSdk(connection);
  const state = await feeState(connection, mint, payer);

  if (!state.exists) {
    return { instructions: null, reason: "no fee sharing config for this mint", state };
  }
  const { vaultPda } = await import("./cycle.mjs");
  const vaultShare = state.shareholders.find(s => s.address === vaultPda(mint).toBase58());
  if (state.editable !== false || vaultShare?.shareBps !== 5000) {
    return { instructions: null, reason: "fee routing is not a verified frozen 50% vault share", state };
  }
  if (state.checkError) {
    return { instructions: null, reason: `pump's distribution check failed: ${state.checkError}`, state };
  }
  if (!state.canDistribute) {
    return {
      instructions: null,
      reason: `${state.distributableLamports} lamports distributable, below pump's ${state.minimumLamports} minimum`,
      state,
    };
  }

  const built = await online.buildDistributeCreatorFeesInstructions(mint, {
    payer,
    quoteMint: WSOL,
  });
  const instructions = built?.instructions ?? [];
  if (!instructions.length) {
    return { instructions: null, reason: "pump produced no instructions", state };
  }
  // On the bonding curve pump now refuses to distribute (CreatorFeesNotSwept,
  // 6095) while fees still sit in the curve's WSOL account. Its own claim
  // button sweeps first; the SDK does not, so this does. Anyone may sign it,
  // and it succeeds with nothing to sweep, so it goes in every time.
  if (!built.isGraduated) instructions.unshift(sweepInstruction(mint, payer));
  return { instructions, reason: null, state };
}

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const wsolAccount = (owner) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()], ATA_PROGRAM)[0];

/**
 * pump's SweepCreatorFee, laid out as pump.fun's own claim sends it: moves
 * the creator fees held in the curve's WSOL account into the creator vault,
 * where DistributeCreatorFees can split them. With the 50/50 split in place
 * the curve's creator is the sharing config, so that is whose vault it is.
 */
export function sweepInstruction(mint, payer) {
  const curve = pump.bondingCurvePda(mint);
  const creatorVault = pump.creatorVaultPda(sharingConfigPda(mint));
  const keys = [
    [payer, true, true],
    [pump.GLOBAL_PDA, false, false],
    [mint, false, false],
    [WSOL, false, false],
    [TOKEN_PROGRAM, false, false],
    [ATA_PROGRAM, false, false],
    [SystemProgram.programId, false, false],
    [curve, false, true],
    [wsolAccount(curve), false, true],
    [creatorVault, false, true],
    [wsolAccount(creatorVault), false, true],
    [pump.PUMP_EVENT_AUTHORITY_PDA, false, false],
    [pump.PUMP_PROGRAM_ID, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));
  return new TransactionInstruction({
    programId: pump.PUMP_PROGRAM_ID,
    keys,
    data: Buffer.from([32, 246, 191, 52, 8, 201, 73, 186]),
  });
}
