/**
 * Building a cycle: the addresses, the market path, and the instruction.
 *
 * Shared by the keeper and the tests so they exercise the same code. When they
 * were separate the tests proved a transaction the keeper never actually
 * builds, which is a way of passing without testing anything.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const pump = requireCjs("@pump-fun/pump-sdk");
// PumpSwap is a separate SDK, and this is not a detail. pump-sdk's
// buyInstructions happily returns a *bonding curve* buy for a token that has
// already graduated -- an instruction naming accounts the pool does not use,
// which fails on chain with nothing pointing at the cause.
const amm = requireCjs("@pump-fun/pump-swap-sdk");
const spl = requireCjs("@solana/spl-token");
const BN = requireCjs("bn.js");

export const PROGRAM = new PublicKey(
  process.env.LOCKEDIN_PROGRAM ?? "EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J",
);
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const LEGACY_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Must match the program. Changing one without the other silently misprices. */
export const VAULT_RENT = 890_880;
export const WSOL_ATA_RENT = 2_039_280;
/** Only used before the vault's token account exists; see holderAtaRent. */
export const HOLDER_ATA_RENT_CEILING_BYTES = 200;
export const MIN_CYCLE = 20_000_000;
export const CALLER_REIMBURSEMENT = 50_000;
/** Per-cycle cap as a share of the market's SOL reserve; must match the program. */
export const RESERVE_CAP_BPS = 20n;
/** pump BondingCurve: discriminator, virtual_token_reserves, then virtual_quote_reserves. */
const CURVE_VIRTUAL_SOL_OFFSET = 16;

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

export const disc = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
export const configPda = () => pda([Buffer.from("cfg")]);
export const vaultPda = (mint) => pda([Buffer.from("lockv"), mint.toBuffer()]);
export const counterPda = (mint) => pda([Buffer.from("cnt"), mint.toBuffer()]);
export const holderPda = (mint, index) =>
  pda([Buffer.from("hold"), mint.toBuffer(), u32(index)]);
export const ataFor = (owner, tokenProgram, mint) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];

/** The loader account holding the program's bytes and its upgrade authority. */
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const programDataPda = () =>
  PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

/**
 * init_config. The program refuses it unless `admin` is the upgrade authority,
 * so it has to run after deployment and before `--final`.
 */
export const initConfigInstruction = (admin) =>
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: programDataPda(), isSigner: false, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("init_config"),
  });

/**
 * Priority fee, micro-lamports per requested compute unit. PRIORITY_MICROLAMPORTS
 * overrides; 0 turns it off. At the default a 400k-unit cycle pays 0.00004 SOL,
 * inside the caller reimbursement, and still lands when mainnet is busy.
 */
export const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_MICROLAMPORTS ?? 100_000);
if (!Number.isSafeInteger(PRIORITY_MICROLAMPORTS) || PRIORITY_MICROLAMPORTS < 0) {
  throw new Error("PRIORITY_MICROLAMPORTS must be a whole number of micro-lamports");
}
export const priorityFee = () =>
  PRIORITY_MICROLAMPORTS > 0
    ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS })]
    : [];

/** The program's errors, in declaration order. 6000 + index. */
export const ERRORS = [
  "Paused", "NotAdmin", "WrongMint", "CycleTooSmall", "WrongHolder",
  "NotPumpProgram", "BadPumpAccounts", "BuyMintMismatch", "BuyerMismatch",
  "NothingBought", "LockFailed", "BadTokenAccount", "CounterFull",
  "UnderSpent", "NotUpgradeAuthority",
];
export const errorCode = (name) => 6000 + ERRORS.indexOf(name);
export const errorName = (code) => ERRORS[code - 6000] ?? `unknown(${code})`;

/** Read the per-mint counter the way any outsider would. */
export async function readCounter(connection, mint) {
  const info = await connection.getAccountInfo(counterPda(mint));
  if (!info) return null;
  const d = info.data;
  if (!info.owner.equals(PROGRAM) || d.length < 58 || !new PublicKey(d.subarray(8,40)).equals(mint)) {
    throw new Error("Counter account failed owner, length or mint validation");
  }
  return {
    mint: new PublicKey(d.subarray(8, 40)).toBase58(),
    nextIndex: d.readUInt32LE(40),
    totalHolders: d.readUInt32LE(44),
    totalLocked: d.readBigUInt64LE(48),
  };
}

export async function tokenBalance(connection, account) {
  const info = await connection.getAccountInfo(account);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * What one holder's token account will cost, read rather than assumed.
 *
 * A Token-2022 account carries its mint's extensions, so its length -- and its
 * rent -- depends on the token. The vault's own token account has the same
 * mint and token program as the holder's is about to have, and therefore the
 * same length, so the exact answer is already on chain. The program does this
 * too, from the same account; a hardcoded number on either side reserves the
 * wrong amount and the runtime rejects the transaction as a whole with
 * InsufficientFundsForRent against an account index.
 */
export async function holderAtaRent(connection, vaultAta) {
  const info = await connection.getAccountInfo(vaultAta);
  if (info) return connection.getMinimumBalanceForRentExemption(info.data.length);
  // It does not exist yet, so its length is not knowable. Reserve generously
  // for this one build: the caller creates it and rebuilds, and that rebuild
  // reads the real length.
  return connection.getMinimumBalanceForRentExemption(HOLDER_ATA_RENT_CEILING_BYTES);
}

/**
 * What a cycle can spend, mirroring the program's own arithmetic.
 *
 * Every rent the cycle pays is reserved first: the vault's own, the new
 * holder's, and on the AMM path the wrapped-SOL account's. Getting this wrong
 * in the keeper does not overspend -- the program reserves the same amounts --
 * it just builds a buy the program then rejects.
 */
export function spendable(
  vaultLamports,
  { graduated, holderRent, vaultRent = VAULT_RENT, wsolRent = WSOL_ATA_RENT },
) {
  const reserved =
    vaultRent +
    holderRent +
    CALLER_REIMBURSEMENT +
    (graduated ? wsolRent : 0);
  return Math.max(0, vaultLamports - reserved);
}

/**
 * What one cycle may spend: the program's cycle_budget, integer for integer.
 * The cap is a share of the SOL reserve of the market being bought from, read
 * at build time; the program reads it again at execution, and a keeper that
 * asked for more than that would build a buy pump rejects.
 */
export function cycleBudget(available, solReserve) {
  const cap = (BigInt(solReserve) * RESERVE_CAP_BPS) / 10_000n;
  const floor = cap > BigInt(MIN_CYCLE) ? cap : BigInt(MIN_CYCLE);
  return Number(BigInt(available) < floor ? BigInt(available) : floor);
}

/** The bonding curve's SOL side, from the account the program reads. */
export async function curveSolReserve(connection, mint) {
  const info = await connection.getAccountInfo(pump.bondingCurvePda(mint));
  if (!info || info.data.length < CURVE_VIRTUAL_SOL_OFFSET + 8) throw new Error("bonding curve account missing");
  return info.data.readBigUInt64LE(CURVE_VIRTUAL_SOL_OFFSET);
}

/** Has the token left the bonding curve? Decides which instruction runs. */
export async function isGraduated(connection, mint) {
  const online = new pump.OnlinePumpSdk(connection);
  const curve = await online.fetchBondingCurve(mint);
  return Boolean(curve.complete);
}

/**
 * Build one cycle.
 *
 * `tokenAmount` is how many tokens to ask for; the program caps what is paid at
 * the vault's spendable balance, so the trade fills at the market's price or
 * pump.fun rejects it. The margin is the caller's guess at slippage and is
 * meant to be stepped -- see the keeper.
 *
 * `lookupTables` turns the result into a v0 transaction. On the AMM path this
 * is not optional: a PumpSwap cycle names 33 distinct accounts, which is 1056
 * bytes of keys on its own and puts a legacy transaction two bytes over the
 * 1232-byte limit. See scripts/make-alt.mjs.
 *
 * `budgetOverride` builds an instruction from a pretended balance, so the
 * account list can be read before the vault holds anything. What it returns
 * must not be sent.
 */
export async function buildCycle(
  connection,
  { mint, caller, index, marginPercent = 99, lookupTables = [], budgetOverride = null },
) {
  const online = new pump.OnlinePumpSdk(connection);
  const sdk = new pump.PumpSdk();

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error("mint does not exist");
  const tokenProgram = mintInfo.owner;

  const vault = vaultPda(mint);
  const vaultAta = ataFor(vault, tokenProgram, mint);
  const vaultWsol = ataFor(vault, LEGACY_TOKEN, WSOL);
  const holder = holderPda(mint, index);
  const holderAta = ataFor(holder, tokenProgram, mint);

  const graduated = await isGraduated(connection, mint);
  const lamports = await connection.getBalance(vault);
  const holderRent = await holderAtaRent(connection, vaultAta);
  // The program reads rent from the cluster; so does this.
  const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
  const wsolRent = await connection.getMinimumBalanceForRentExemption(165);
  const available = budgetOverride ?? spendable(lamports, { graduated, holderRent, vaultRent, wsolRent });
  if (available < MIN_CYCLE) {
    return { ready: false, reason: "below the minimum cycle", budget: available, graduated };
  }
  // Capped by the market's SOL reserve; the AMM branch replaces this once it
  // has read the pool.
  let budget = budgetOverride ?? (graduated ? available : cycleBudget(available, await curveSolReserve(connection, mint)));

  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const supply = new BN((await connection.getTokenSupply(mint)).value.amount);

  let buy;
  let tokenAmount;
  let prepare = null;
  if (graduated) {
    const poolKey = amm.canonicalPumpPoolPda(mint, WSOL);
    const state = await new amm.OnlinePumpAmmSdk(connection).swapSolanaState(poolKey, vault);
    if (!state.pool.baseMint.equals(mint) || !state.pool.quoteMint.equals(WSOL)) {
      throw new Error("the canonical pool is not this mint against SOL");
    }
    if (budgetOverride === null) budget = cycleBudget(available, state.poolQuoteAmount.toString());
    const quote = amm.buyQuoteInput({
      quote: new BN(budget),
      slippage: 0,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      feeConfig: state.feeConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: mint,
      quoteMint: WSOL,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    });
    tokenAmount = quote.base.muln(marginPercent).divn(100);
    if (tokenAmount.isZero()) {
      return { ready: false, reason: "the pool quoted zero tokens", budget, graduated };
    }
    const ixs = await amm.PUMP_AMM_SDK.buyInstructionsNoPool(
      state,
      tokenAmount,
      new BN(budget),
    );
    buy = ixs.find(
      (ix) => ix.programId.equals(PUMP_AMM_PROGRAM) &&
        ix.data.subarray(0, 8).equals(BUY_DISCRIMINATOR),
    );
    if (!buy) throw new Error("the PumpSwap SDK produced no buy instruction");
    // Position checks, because a CPI whose account list is wrong by one fails
    // at runtime with nothing useful to say.
    if (!buy.keys[0].pubkey.equals(poolKey) ||
        !buy.keys[1].pubkey.equals(vault) ||
        !buy.keys[3].pubkey.equals(mint)) {
      throw new Error("unexpected PumpSwap buy account layout");
    }

    // A PumpSwap buy pays several fee recipients in wrapped SOL and creates
    // their token accounts inside the buy, charging the buyer -- which here is
    // a vault whose entire balance is already committed to the trade. It fails
    // as a bare System Program 0x1 four frames down, naming nothing.
    //
    // So they are created first, by the caller. Which accounts those are is
    // worked out by derivation rather than by position: an earlier version
    // named them as buy.keys[10], [17], [last-1] and so on, which was wrong in
    // a way nothing caught, because a list of ATAs created successfully looks
    // the same whether or not they were the ATAs that mattered. Every writable
    // account the buy names is checked for existence, and each missing one is
    // matched against the associated-token address of every other account in
    // the instruction. Pump can reorder their accounts freely.
    prepare = [];
    const unresolved = [];
    const pairs = [[WSOL, LEGACY_TOKEN], [mint, tokenProgram]];

    // The vault's volume accumulator is a PumpSwap PDA, not a token account,
    // so the derivation below will never match it. It is created by its own
    // instruction and is recognised here so that a missing one reads as work
    // to do rather than as an account nobody can explain.
    const volumeAccumulator = amm.userVolumeAccumulatorPda(vault);

    // Every protocol fee recipient, not only the one this build drew.
    //
    // PumpSwap picks one of eight at random per buy and will not create its
    // wrapped-SOL account. Creating just the one this build chose leaves the
    // next build a one-in-eight chance of needing another, so settling becomes
    // a random walk that sometimes does not finish -- it gave up after six
    // rounds on a clean ledger. Eight accounts is a bounded, one-time cost,
    // and paying it removes the randomness instead of retrying it.
    const recipients = state.globalConfig?.protocolFeeRecipients ?? [];
    const candidates = [
      ...buy.keys.filter((k) => k.isWritable).map((k) => k.pubkey),
      ...recipients.map((r) => ataFor(r, LEGACY_TOKEN, WSOL)),
    ];
    const writable = [];
    const seenCandidate = new Set();
    for (const key of candidates) {
      const s58 = key.toBase58();
      if (seenCandidate.has(s58)) continue;
      seenCandidate.add(s58);
      writable.push(key);
    }
    // The recipients themselves can own their fee accounts, and are not always
    // named by this particular buy.
    const owners = [...buy.keys.map((k) => k.pubkey), ...recipients];

    const infos = [];
    for (let n = 0; n < writable.length; n += 100) {
      infos.push(...(await connection.getMultipleAccountsInfo(writable.slice(n, n + 100))));
    }

    for (let n = 0; n < writable.length; n++) {
      if (infos[n]) continue;
      const target = writable[n];
      if (target.equals(volumeAccumulator)) continue;
      // The vault's own wrapped-SOL account is closed at the end of every
      // cycle and re-created by the program at the vault's expense. Creating
      // it here would charge the caller its rent on every PumpSwap cycle and
      // hand that rent to the vault when the cycle closes it.
      if (target.equals(vaultWsol)) continue;
      let matched = false;
      for (const owner of owners) {
        for (const [m, prog] of pairs) {
          if (!ataFor(owner, prog, m).equals(target)) continue;
          prepare.push(
            spl.createAssociatedTokenAccountIdempotentInstruction(caller, target, owner, m, prog),
          );
          matched = true;
          break;
        }
        if (matched) break;
      }
      // Not an associated token account, or an owner the instruction does not
      // name. Reported rather than guessed at, so the keeper can refuse out
      // loud instead of sending a transaction that cannot work.
      if (!matched) unresolved.push(target.toBase58());
    }

    if (!(await connection.getAccountInfo(volumeAccumulator))) {
      prepare.push(await amm.PUMP_AMM_SDK.initUserVolumeAccumulator({ payer: caller, user: vault }));
    }
    if (state.poolAccountInfo.data.length < amm.POOL_ACCOUNT_NEW_SIZE) {
      prepare.push(await amm.PUMP_AMM_SDK.extendAccount(poolKey, caller));
    }
    if (unresolved.length) {
      return {
        ready: false,
        reason: `the buy needs accounts that are not associated token accounts: ${unresolved.join(", ")}`,
        budget, graduated, prepare,
      };
    }
    if (!prepare.length) prepare = null;
  } else {
    // The vault's own token account, on the path that has no fee recipients to
    // create and therefore had no preparation step at all. Without it the
    // program reads a zero-length account and refuses with BadTokenAccount --
    // which is correct, and reads like a bug in the mechanism rather than a
    // missing account. It is created once, ever, on the first cycle.
    //
    // The AMM path already creates it, as one of the writable accounts its buy
    // names, which is why this only ever failed on the curve: the first market
    // the token is on, and the one every launch starts in.
    prepare = [];
    if (!(await connection.getAccountInfo(vaultAta))) {
      prepare.push(
        spl.createAssociatedTokenAccountIdempotentInstruction(
          caller, vaultAta, vault, mint, tokenProgram,
        ),
      );
    }

    // The buyer's volume accumulator. pump creates it inside the buy and
    // charges the buyer, which here is a vault whose balance is committed to
    // the lamport. The shortfall comes out of the vault's own rent and the
    // runtime rejects the transaction with InsufficientFundsForRent naming the
    // vault -- on the first cycle of every token, before a single lock.
    //
    // The AMM path already creates it, which is why this only ever failed on
    // the curve: the market every launch starts in.
    const curveAccumulator = pump.userVolumeAccumulatorPda(vault);
    if (!(await connection.getAccountInfo(curveAccumulator))) {
      prepare.push(
        await sdk.initUserVolumeAccumulator({ payer: caller, user: vault }),
      );
    }
    if (!prepare.length) prepare = null;

    const state = await online.fetchBuyState(mint, vault);
    tokenAmount = pump
      .getBuyTokenAmountFromSolAmount({
        global, feeConfig, mintSupply: supply,
        bondingCurve: state.bondingCurve, amount: new BN(budget), quoteMint: WSOL,
      })
      .muln(marginPercent)
      .divn(100);
    const ixs = await sdk.buyInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint, user: vault, amount: tokenAmount, solAmount: new BN(budget),
      slippage: 0, tokenProgram,
    });
    buy = ixs.find(
      (ix) => ix.programId.equals(PUMP_PROGRAM) &&
        ix.data.subarray(0, 8).equals(BUY_DISCRIMINATOR),
    );
  }
  if (!buy) throw new Error("the pump SDK produced no buy instruction");
  if (tokenAmount.isZero()) {
    return { ready: false, reason: "the quote came back as zero tokens", budget, graduated };
  }

  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: counterPda(mint), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: holder, isSigner: false, isWritable: false },
      { pubkey: holderAta, isSigner: false, isWritable: true },
      { pubkey: graduated ? PUMP_AMM_PROGRAM : PUMP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: vaultWsol, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: LEGACY_TOKEN, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // The pump accounts are passed through untouched and validated on chain.
      // Nothing here is trusted: the program re-derives the pool, checks the
      // buyer is the vault and the mint is this vault's.
      ...buy.keys.map((k) => ({ ...k, isSigner: false })),
    ],
    data: Buffer.concat([
      disc(graduated ? "lock_in_cycle_amm" : "lock_in_cycle"),
      u64(tokenAmount.toString()),
      u64(1n),
    ]),
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...priorityFee(),
    instruction,
  ];

  // A v0 transaction the moment a lookup table is offered. The bonding curve
  // path fits either way; the AMM path only fits this one.
  const transaction = lookupTables.length
    ? new VersionedTransaction(
        new TransactionMessage({
          payerKey: caller,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions,
        }).compileToV0Message(lookupTables),
      )
    : new Transaction().add(...instructions);

  return {
    ready: true, transaction, instruction, instructions, graduated, budget, index, holderRent,
    holder, holderAta, tokenAmount: tokenAmount.toString(),
    versioned: lookupTables.length > 0,
    // Only set on the AMM path, and only when something actually needs
    // creating. Submit these first; they touch no capital.
    prepare,
  };
}

/**
 * Send either kind of transaction.
 *
 * A legacy transaction takes its blockhash and signers by assignment, a v0 one
 * by recompiling the message. Callers should not have to care which they were
 * handed, and when they did have to, they got it wrong.
 */
export async function signAndSend(connection, built, payer, { commitment = "confirmed" } = {}) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  let raw;
  if (built.versioned) {
    // The blockhash is baked into a compiled v0 message, so it is recompiled
    // rather than assigned. The lookup tables are already resolved in it.
    built.transaction.message.recentBlockhash = blockhash;
    built.transaction.sign([payer]);
    raw = built.transaction.serialize();
  } else {
    built.transaction.feePayer = payer.publicKey;
    built.transaction.recentBlockhash = blockhash;
    built.transaction.sign(payer);
    raw = built.transaction.serialize();
  }
  const signature = await connection.sendRawTransaction(raw);
  await confirmSuccess(connection, { signature, blockhash, lastValidBlockHeight }, commitment);
  return signature;
}

/**
 * Wait for a transaction by polling its status, never by websocket.
 *
 * web3.js confirms through `signatureSubscribe`, and the production RPC (Alchemy) does not offer it:
 * on mainnet, 2026-10-05, the setup transaction landed and finalized while the script sat retrying a
 * subscription that answered "method not found". Polling works on every RPC. A landed transaction
 * that failed is never success; one whose blockhash expired unseen is reported as expired.
 */
export async function confirmSuccess(connection, strategy, commitment = "confirmed") {
  const signature = typeof strategy === "string" ? strategy : strategy.signature;
  const lastValid = typeof strategy === "object" ? strategy.lastValidBlockHeight : undefined;
  const done = (s) => s && (s.confirmationStatus === "finalized" || (commitment !== "finalized" && s.confirmationStatus === "confirmed"));
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value?.[0];
    if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    if (done(s)) return { value: { err: null } };
    if (lastValid != null && (await connection.getBlockHeight("confirmed")) > lastValid) {
      const { value: late } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (late?.[0]?.err) throw new Error(`Transaction failed: ${JSON.stringify(late[0].err)}`);
      if (late?.[0]) return { value: { err: null } };
      throw new Error(`Transaction expired before it landed: ${signature}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

/** Sign a legacy transaction with fresh blockhash, send it, and confirm it by polling. */
export async function sendAndConfirm(connection, transaction, signers, commitment = "confirmed") {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = transaction.feePayer ?? signers[0].publicKey;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 });
  await confirmSuccess(connection, { signature, blockhash, lastValidBlockHeight }, commitment);
  return signature;
}

/** Bytes a signed cycle would take, measurable even when it is too big to send. */
export function transactionSize(built, payer) {
  if (built.versioned) return built.transaction.serialize().length;
  const copy = built.transaction;
  copy.feePayer = payer;
  copy.recentBlockhash = copy.recentBlockhash ?? PublicKey.default.toBase58();
  return copy.compileMessage().serialize().length + 1 + 64;
}

/**
 * Build a cycle that is actually sendable: prepare, rebuild, repeat.
 *
 * PumpSwap picks a protocol fee recipient at random for each buy, out of eight,
 * and will not create that recipient's wrapped-SOL account for you -- it
 * creates it inside the buy and charges the buyer, which is a vault whose
 * balance is already spoken for. So preparing the accounts one build needs and
 * then sending a different build is a coin flip: a fresh build can name a
 * recipient the previous one did not.
 *
 * That is not a test artifact. A keeper that rebuilds to step its slippage
 * would hit it on mainnet, intermittently, as a System Program 0x1 with
 * nothing in the logs connecting it to a fee recipient.
 *
 * So: build, create whatever that build needs, build again, and only send a
 * build that needs nothing. It converges -- the accounts are permanent, and
 * once all eight exist no cycle ever needs preparing again.
 */
export async function settleAndBuild(connection, options, payer, { attempts = 6 } = {}) {
  const prepared = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const built = await buildCycle(connection, options);
    if (!built.ready) return { ...built, prepared };
    if (!built.prepare?.length) return { ...built, prepared };

    const tx = new Transaction().add(...priorityFee(), ...built.prepare);
    tx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await confirmSuccess(connection, { signature, blockhash, lastValidBlockHeight });
    prepared.push({ signature, accounts: built.prepare.length });
  }
  return {
    ready: false,
    reason: `still needed accounts created after ${attempts} builds`,
    prepared,
  };
}

/**
 * Simulate either kind of transaction, and return the cluster's value.
 *
 * A legacy transaction simulates from an assigned blockhash; a v0 one has to
 * have the blockhash replaced by the node and signature verification turned
 * off, or it fails for reasons that have nothing to do with the cycle.
 */
export async function simulateBuilt(connection, built, payer) {
  if (built.versioned) {
    const res = await connection.simulateTransaction(built.transaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "confirmed",
    });
    return res.value;
  }
  built.transaction.feePayer = payer;
  built.transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const res = await connection.simulateTransaction(built.transaction);
  return res.value;
}

/** The program error in a failed simulation, or null if it failed elsewhere. */
export function programError(simValue) {
  const custom = simValue?.err?.InstructionError?.[1]?.Custom;
  return typeof custom === "number" ? custom : null;
}

/** True when a failure is the market moving, which buying less can fix. */
export function isSlippage(simValue) {
  const logs = simValue?.logs ?? [];
  if (logs.some((l) => /TooMuchSolRequired|slippage/i.test(l))) return true;

  // pump does not always get to raise its own slippage error. When the buy
  // needs more lamports than the vault holds, the System Program refuses the
  // transfer first and what comes back is a bare Custom 1 -- its
  // ResultWithNegativeLamports -- naming an instruction index and nothing else.
  //
  // It means exactly what slippage means here: ask for fewer tokens. Reading it
  // as an unknown failure instead made the keeper abandon the margin ladder on
  // its first rung, every time, on the error the ladder exists for. Matched
  // narrowly, on the System Program being the one that failed, because Custom 1
  // from anything else is a different problem.
  const custom = simValue?.err?.InstructionError?.[1]?.Custom;
  return (
    custom === 1 &&
    logs.some((l) => l.startsWith(`Program ${SystemProgram.programId.toBase58()} failed`))
  );
}
