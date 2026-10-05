import { PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { feeState } from './fees.mjs';
import { vaultPda, WSOL, LEGACY_TOKEN } from './cycle.mjs';
const pump = createRequire(import.meta.url)('@pump-fun/pump-sdk');

export function correctFrozenSplit(state, vault, creator) {
  return state.exists && state.editable === false && state.shareholders.length === 2 &&
    state.shareholders.some(s => s.address === vault.toBase58() && s.shareBps === 5000) &&
    state.shareholders.some(s => s.address === creator.toBase58() && s.shareBps === 5000);
}

/** Build the one-shot split atomically, including the default creator shareholder. */
export async function buildFeeSplit(connection, mint, creator) {
  const vault = vaultPda(mint);
  const before = await feeState(connection, mint, creator, { check: false });
  if (correctFrozenSplit(before, vault, creator)) return { instructions: [], before };
  if (before.exists && before.editable !== true) {
    throw new Error('Existing fee configuration cannot be edited or is unverified; it does not match the required frozen 50/50 split');
  }
  const sdk = new pump.PumpSdk();
  const pool = pump.canonicalPumpPoolPda(mint, WSOL);
  const poolInfo = await connection.getAccountInfo(pool);
  const instructions = [];
  if (!before.exists) {
    instructions.push(await sdk.createFeeSharingConfig({ creator, mint, pool: poolInfo ? pool : null }));
  }
  instructions.push(await sdk.updateFeeSharesV2({
    authority: creator,
    mint,
    currentShareholders: before.exists ? before.shareholders.map(s => new PublicKey(s.address)) : [creator],
    newShareholders: [{address:vault,shareBps:5000},{address:creator,shareBps:5000}],
    quoteMint: WSOL,
    quoteTokenProgram: LEGACY_TOKEN,
  }));
  return { instructions, before };
}
