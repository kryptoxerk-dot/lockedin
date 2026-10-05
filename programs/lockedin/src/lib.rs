//! Locked In — creator fees buy the token and lock it where nobody can sell it.
//!
//! Half of every creator fee arrives in a per-mint vault. When enough has
//! collected, one permissionless instruction spends it on the open market and
//! moves the entire purchase into a brand new address that has no private key.
//! The holder count grows by one each time, for as long as the token trades.
//!
//! The whole value of this program is what it CANNOT do. There is no withdraw,
//! no close, no admin transfer, and no authority over a holder account once it
//! exists. `set_paused` can stop new cycles and nothing else, and
//! `renounce_admin` gives that up permanently; neither can reach a
//! single token that has already been locked. Do not add an escape hatch here.
//! The absence is the product, and a reader can verify it by grepping this file
//! for the holder seed and finding exactly one instruction that touches it.
//!
//! The market adapters, the account validation and the raw-CPI approach come
//! from an earlier buyback design that ran on mainnet; the traps it hit are
//! called out below where they shaped this file.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

declare_id!("EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J");

// ---------------------------------------------------------------------------
// Seeds and constants
// ---------------------------------------------------------------------------

pub const SEED_CONFIG: &[u8] = b"cfg";
/// Holds the fee share for one mint. System-owned; only this program signs it.
pub const SEED_VAULT: &[u8] = b"lockv";
/// Per-mint counter: how many holders exist and how much is locked.
pub const SEED_COUNTER: &[u8] = b"cnt";
/// `["hold", mint, index_le_u32]` — one per locked address, for ever.
pub const SEED_HOLDER: &[u8] = b"hold";

pub const PUMP_PROGRAM: Pubkey = anchor_lang::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM: Pubkey = anchor_lang::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub const PUMP_BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const WSOL_MINT: Pubkey = anchor_spl::token::spl_token::native_mint::ID;
/// Accounts PumpSwap's `buy` expects. One position wrong fails at runtime
/// with nothing useful to say, so every index used below is checked.
pub const AMM_BUY_ACCOUNTS: usize = 23;
pub const PUMP_BUY_ACCOUNTS: usize = 18;
pub const PUMP_BUY_MINT_INDEX: usize = 2;
pub const PUMP_BUY_USER_INDEX: usize = 6;

/// Rent for a system account with no data. The vault must never drop below it:
/// a vault that stops existing has nowhere for the next fee payment to land.
pub const VAULT_RENT_EXEMPT: u64 = 890_880;

/// Rent for one Token-2022 associated token account.
///
/// Not a constant, because it is not constant. Token-2022 accounts carry the
/// extensions their mint carries, so their length -- and their rent -- depends
/// on the token. This was a measured number, taken from a live pump.fun v2
/// account, and a token created by a later pump version produced a 170-byte
/// account needing 2_074_080 rather than the measured 1_513_840. The reserve
/// fell 560_240 short, the shortfall came out of the vault's own rent, and the
/// runtime rejected the whole transaction with InsufficientFundsForRent
/// against an account index -- on every cycle, for ever, on a token earning
/// normally.
///
/// The exact answer is already on chain. The vault's own token account has the
/// same mint and the same token program as the holder's is about to have, so
/// it has the same length. Read it rather than predict it.
fn holder_ata_rent(vault_ata: &UncheckedAccount) -> Result<u64> {
    let len = vault_ata.data_len();
    require!(len >= 72, LockError::BadTokenAccount);
    Ok(Rent::get()?.minimum_balance(len))
}

/// Rent for a legacy SPL wrapped-SOL account. Unlike the holder's, this one is
/// reclaimed: the account closes back into the vault at the end of the cycle.
pub const WSOL_ATA_RENT: u64 = 2_039_280;

/// The smallest cycle worth running, chosen so account rent is about 8% of the
/// spend. Below this the mechanism mostly buys rent instead of tokens.
pub const MIN_CYCLE_LAMPORTS: u64 = 20_000_000;

/// The smallest share of its budget a cycle must actually spend on the buy.
///
/// The caller chooses how many tokens to ask for. Without a floor, asking for a
/// single base unit is a valid cycle: the vault still pays a whole holder
/// account's rent and the caller's reimbursement, and buys next to nothing.
/// Repeated every time fees lift the vault over the minimum, that turns the
/// mechanism's SOL into rent for dust holders, at a small profit to whoever
/// calls it -- and the buy pressure, which is the point, never happens. It was
/// found before deploy by asking what a hostile caller would choose; none of
/// the tests at the time tried a funded vault with a dust buy.
///
/// Half is far below anything the keeper's slippage ladder reaches (its lowest
/// rung spends about three quarters) and far above anything a dust buy can.
pub const MIN_SPEND_BPS: u64 = 5_000;

/// Refuse a cycle that spent less than MIN_SPEND_BPS of its budget.
///
/// u128 because `spendable * 10_000` overflows a u64 above about 1.8 million
/// SOL, and a check that wraps around is worse than no check.
fn require_spent(spent: u64, spendable: u64) -> Result<()> {
    require!(
        (spent as u128) * 10_000 >= (spendable as u128) * (MIN_SPEND_BPS as u128),
        LockError::UnderSpent
    );
    Ok(())
}

/// What a caller may be paid back for submitting a cycle.
///
/// Anyone can call this instruction, which is only true in practice if running
/// it does not cost money. Capped, and small enough that calling in a loop
/// earns nothing: a cycle cannot run at all without MIN_CYCLE in the vault, so
/// there is no sequence of calls that drains the vault through this.
pub const MAX_CALLER_REIMBURSEMENT: u64 = 50_000;

// ---------------------------------------------------------------------------

#[program]
pub mod lockedin {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Stop new cycles. Reaches nothing that is already locked.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Give up the pause, for good.
    ///
    /// The admin can stop new cycles and nothing else. Once the program is
    /// immutable and the fee split frozen, that is the last lever anyone holds
    /// over the mechanism -- and since a paused vault keeps receiving its share
    /// with no instruction able to spend it, a pause that is never lifted would
    /// strand that SOL for ever. This sets the admin to the zero address, which
    /// nobody can sign for, so the pause can never be pressed again. Anyone can
    /// check it: the config's admin field reads 11111111111111111111111111111111.
    ///
    /// Refused while paused: renouncing then would leave the mechanism paused
    /// permanently, with nobody able to lift it.
    pub fn renounce_admin(ctx: Context<SetPaused>) -> Result<()> {
        require!(!ctx.accounts.config.paused, LockError::Paused);
        ctx.accounts.config.admin = Pubkey::default();
        Ok(())
    }

    /// Register a mint: create its counter and fund its vault's rent.
    ///
    /// Permissionless on purpose. The counter is seeded by the mint, so this
    /// cannot be pointed at another token's state, and creating one for a token
    /// nobody uses costs the caller rent and achieves nothing.
    pub fn init_token(ctx: Context<InitToken>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.mint = ctx.accounts.mint.key();
        counter.next_index = 0;
        counter.total_holders = 0;
        counter.total_locked = 0;
        counter.bump = ctx.bumps.counter;
        counter.vault_bump = ctx.bumps.vault;

        // The vault is a plain system account that receives fee payments. It
        // needs rent before anything can pay into it.
        let vault = ctx.accounts.vault.to_account_info();
        if vault.lamports() < VAULT_RENT_EXEMPT {
            let top_up = VAULT_RENT_EXEMPT - vault.lamports();
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(ctx.accounts.payer.key, vault.key, top_up),
                &[
                    ctx.accounts.payer.to_account_info(),
                    vault.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        emit!(TokenRegistered { mint: counter.mint, vault: vault.key() });
        Ok(())
    }

    /// Buy with the vault's fees and lock the purchase into a fresh address.
    ///
    /// Atomic by construction: the buy, the transfer and the counter bump are
    /// one instruction, so a purchase can never be left sitting anywhere it
    /// could be sold from. `token_amount` is how many tokens to ask for and the
    /// spendable balance caps what will be paid, so the trade fills at the
    /// market's price or pump.fun rejects it. The caller cannot make the vault
    /// overpay beyond what it holds, and cannot choose where the tokens land.
    pub fn lock_in_cycle(
        ctx: Context<LockInCycle>,
        token_amount: u64,
        min_tokens_locked: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, LockError::Paused);

        let mint_key = ctx.accounts.mint.key();
        let counter = &ctx.accounts.counter;
        require_keys_eq!(counter.mint, mint_key, LockError::WrongMint);

        let index = counter.next_index;
        let vault = ctx.accounts.vault.to_account_info();

        // Everything this cycle must pay for, reserved before deciding how much
        // is left to spend on tokens. The vault funds its own rent, the new
        // holder's rent and the caller's fee -- the keeper funds nothing.
        //
        // A keeper that fronts per-cycle rent it never recovers runs dry after
        // a dozen or so cycles, then declines once a minute while looking
        // exactly like "no fees have arrived yet". So the vault pays.
        let reserved = VAULT_RENT_EXEMPT
            .saturating_add(holder_ata_rent(&ctx.accounts.vault_ata)?)
            .saturating_add(MAX_CALLER_REIMBURSEMENT);
        let spendable = vault.lamports().saturating_sub(reserved);
        require!(spendable >= MIN_CYCLE_LAMPORTS, LockError::CycleTooSmall);

        // --- the holder for this cycle, derived rather than supplied --------
        let index_bytes = index.to_le_bytes();
        let (expected_holder, _) = Pubkey::find_program_address(
            &[SEED_HOLDER, mint_key.as_ref(), &index_bytes],
            &crate::ID,
        );
        require_keys_eq!(
            ctx.accounts.holder.key(),
            expected_holder,
            LockError::WrongHolder
        );

        let token_program_key = ctx.accounts.token_program.key();
        let expected_holder_ata = associated_token_address(
            &expected_holder,
            &token_program_key,
            &mint_key,
        );
        require_keys_eq!(
            ctx.accounts.holder_ata.key(),
            expected_holder_ata,
            LockError::WrongHolder
        );

        // --- the three things pump.fun will not check for us ---------------
        let accounts = ctx.remaining_accounts;
        require!(accounts.len() >= PUMP_BUY_ACCOUNTS, LockError::BadPumpAccounts);
        require_keys_eq!(
            ctx.accounts.pump_program.key(),
            PUMP_PROGRAM,
            LockError::NotPumpProgram
        );
        require_keys_eq!(
            accounts[PUMP_BUY_MINT_INDEX].key(),
            mint_key,
            LockError::BuyMintMismatch
        );
        require_keys_eq!(
            accounts[PUMP_BUY_USER_INDEX].key(),
            vault.key(),
            LockError::BuyerMismatch
        );

        let expected_vault_ata =
            associated_token_address(&vault.key(), &token_program_key, &mint_key);
        require_keys_eq!(
            ctx.accounts.vault_ata.key(),
            expected_vault_ata,
            LockError::BadPumpAccounts
        );
        require_keys_eq!(accounts[5].key(), expected_vault_ata, LockError::BadPumpAccounts);
        require_keys_eq!(accounts[8].key(), token_program_key, LockError::BadPumpAccounts);
        require_keys_eq!(*ctx.accounts.mint.owner, token_program_key, LockError::BadPumpAccounts);

        let vault_bump = [counter.vault_bump];
        let vault_seeds: &[&[u8]] = &[SEED_VAULT, mint_key.as_ref(), &vault_bump];

        // --- 1. the holder's token account, paid for by the vault ----------
        create_holder_account(&ctx, &[vault_seeds])?;

        // --- 2. buy ---------------------------------------------------------
        let before = token_account_amount(&ctx.accounts.vault_ata)?;
        // The holder's rent has already left the vault, so the difference
        // across the CPI is exactly what pump took for the tokens.
        let lamports_before_buy = vault.lamports();

        let mut data = Vec::with_capacity(25);
        data.extend_from_slice(&PUMP_BUY_DISCRIMINATOR);
        data.extend_from_slice(&token_amount.to_le_bytes());
        data.extend_from_slice(&spendable.to_le_bytes());
        data.push(0); // track_volume: Option<bool> = None

        let metas: Vec<AccountMeta> = accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.key() == vault.key(),
                is_writable: a.is_writable,
            })
            .collect();
        invoke_signed(
            &anchor_lang::solana_program::instruction::Instruction {
                program_id: PUMP_PROGRAM,
                accounts: metas,
                data,
            },
            accounts,
            &[vault_seeds],
        )?;

        let after = token_account_amount(&ctx.accounts.vault_ata)?;
        let bought = after.saturating_sub(before);
        require!(
            bought > 0 && bought >= min_tokens_locked,
            LockError::NothingBought
        );
        require_spent(lamports_before_buy.saturating_sub(vault.lamports()), spendable)?;

        // --- 3. lock: everything bought, into the holder --------------------
        transfer_all_to_holder(
            &ctx,
            after,
            expected_vault_ata,
            expected_holder_ata,
            &[vault_seeds],
        )?;

        let locked_here = token_account_amount(&ctx.accounts.holder_ata)?;
        require!(locked_here >= bought, LockError::LockFailed);

        // --- 4. record ------------------------------------------------------
        // Scoped so the mutable borrow of `counter` ends before anything else
        // reads `ctx`; the values the event needs are copied out here.
        let (total_holders, total_locked) = {
            let counter = &mut ctx.accounts.counter;
            counter.next_index =
                counter.next_index.checked_add(1).ok_or(LockError::CounterFull)?;
            counter.total_holders =
                counter.total_holders.checked_add(1).ok_or(LockError::CounterFull)?;
            counter.total_locked = counter.total_locked.saturating_add(locked_here);
            (counter.total_holders, counter.total_locked)
        };

        // --- 5. pay the caller ----------------------------------------------
        reimburse_caller(&ctx, &[vault_seeds])?;

        emit!(LockedIn {
            mint: mint_key,
            index,
            holder: expected_holder,
            holder_ata: expected_holder_ata,
            amount: locked_here,
            total_holders,
            total_locked,
        });
        Ok(())
    }

    /// The same cycle, on the canonical PumpSwap pool after graduation.
    ///
    /// A token leaves the bonding curve within hours of a decent launch, so
    /// this is not an optional extra. The pool is derived rather than accepted
    /// from the caller: given only an address, a caller could route the vault's
    /// money through a pool they created at whatever price they liked.
    ///
    /// Buying here needs wrapped SOL, so the vault wraps what it is about to
    /// spend and unwraps the remainder in the same instruction. **The vault
    /// pays that account's rent, not the caller.** A keeper that fronted it
    /// would never get it back, run dry after a dozen or so cycles, and then
    /// look exactly like a token that had stopped earning fees.
    pub fn lock_in_cycle_amm<'info>(
        ctx: Context<'_, '_, '_, 'info, LockInCycle<'info>>,
        token_amount: u64,
        min_tokens_locked: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, LockError::Paused);

        let mint_key = ctx.accounts.mint.key();
        let counter = &ctx.accounts.counter;
        require_keys_eq!(counter.mint, mint_key, LockError::WrongMint);
        let index = counter.next_index;
        let vault = ctx.accounts.vault.to_account_info();
        let token_program_key = ctx.accounts.token_program.key();

        // The wrapped-SOL account's rent is reserved too. It comes back when
        // the account closes at the end, but it has to be there to begin with.
        let reserved = VAULT_RENT_EXEMPT
            .saturating_add(holder_ata_rent(&ctx.accounts.vault_ata)?)
            .saturating_add(WSOL_ATA_RENT)
            .saturating_add(MAX_CALLER_REIMBURSEMENT);
        let spendable = vault.lamports().saturating_sub(reserved);
        require!(spendable >= MIN_CYCLE_LAMPORTS, LockError::CycleTooSmall);

        let index_bytes = index.to_le_bytes();
        let (expected_holder, _) =
            Pubkey::find_program_address(&[SEED_HOLDER, mint_key.as_ref(), &index_bytes], &crate::ID);
        require_keys_eq!(ctx.accounts.holder.key(), expected_holder, LockError::WrongHolder);
        let expected_holder_ata =
            associated_token_address(&expected_holder, &token_program_key, &mint_key);
        require_keys_eq!(
            ctx.accounts.holder_ata.key(),
            expected_holder_ata,
            LockError::WrongHolder
        );

        // --- the pool, derived rather than trusted --------------------------
        let accounts = ctx.remaining_accounts;
        require!(accounts.len() >= AMM_BUY_ACCOUNTS, LockError::BadPumpAccounts);
        require_keys_eq!(
            ctx.accounts.pump_program.key(),
            PUMP_AMM_PROGRAM,
            LockError::NotPumpProgram
        );
        require_keys_eq!(accounts[1].key(), vault.key(), LockError::BuyerMismatch);
        require_keys_eq!(accounts[3].key(), mint_key, LockError::BuyMintMismatch);
        require_keys_eq!(accounts[4].key(), WSOL_MINT, LockError::BadPumpAccounts);
        require_keys_eq!(accounts[11].key(), token_program_key, LockError::BadPumpAccounts);
        require_keys_eq!(*ctx.accounts.mint.owner, token_program_key, LockError::BadPumpAccounts);
        require_keys_eq!(accounts[12].key(), anchor_spl::token::ID, LockError::BadPumpAccounts);

        let authority =
            Pubkey::find_program_address(&[b"pool-authority", mint_key.as_ref()], &PUMP_PROGRAM).0;
        let pool = Pubkey::find_program_address(
            &[b"pool", &[0, 0], authority.as_ref(), mint_key.as_ref(), WSOL_MINT.as_ref()],
            &PUMP_AMM_PROGRAM,
        )
        .0;
        require_keys_eq!(accounts[0].key(), pool, LockError::BadPumpAccounts);

        let base_ata = associated_token_address(&vault.key(), &token_program_key, &mint_key);
        let quote_ata =
            associated_token_address(&vault.key(), &anchor_spl::token::ID, &WSOL_MINT);
        require_keys_eq!(ctx.accounts.vault_ata.key(), base_ata, LockError::BadPumpAccounts);
        require_keys_eq!(ctx.accounts.vault_wsol.key(), quote_ata, LockError::BadPumpAccounts);
        require_keys_eq!(accounts[5].key(), base_ata, LockError::BadPumpAccounts);
        require_keys_eq!(accounts[6].key(), quote_ata, LockError::BadPumpAccounts);

        let vault_bump = [counter.vault_bump];
        let vault_seeds: &[&[u8]] = &[SEED_VAULT, mint_key.as_ref(), &vault_bump];

        // --- 1. the holder's account and the wrapped-SOL account ------------
        create_holder_account(&ctx, &[vault_seeds])?;
        create_ata_for_vault(
            &ctx,
            &ctx.accounts.vault_wsol,
            &ctx.accounts.wsol_mint,
            &ctx.accounts.legacy_token_program,
            &[vault_seeds],
        )?;

        // --- 2. wrap exactly what is about to be spent ----------------------
        invoke_signed(
            &system_instruction::transfer(vault.key, &quote_ata, spendable),
            &[
                vault.clone(),
                ctx.accounts.vault_wsol.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;
        invoke_signed(
            &anchor_spl::token::spl_token::instruction::sync_native(
                &anchor_spl::token::ID,
                &quote_ata,
            )?,
            &[
                ctx.accounts.vault_wsol.to_account_info(),
                ctx.accounts.legacy_token_program.to_account_info(),
            ],
            &[],
        )?;

        // --- 3. buy ---------------------------------------------------------
        let before = token_account_amount(&ctx.accounts.vault_ata)?;
        // Exactly `spendable` was wrapped above, so what the buy spent is the
        // wrapped balance before minus after.
        let wsol_before = token_account_amount(&ctx.accounts.vault_wsol)?;
        let mut data = Vec::with_capacity(25);
        data.extend_from_slice(&PUMP_BUY_DISCRIMINATOR);
        data.extend_from_slice(&token_amount.to_le_bytes());
        data.extend_from_slice(&spendable.to_le_bytes());
        data.push(0);
        let metas: Vec<AccountMeta> = accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.key() == vault.key(),
                is_writable: a.is_writable,
            })
            .collect();
        invoke_signed(
            &anchor_lang::solana_program::instruction::Instruction {
                program_id: PUMP_AMM_PROGRAM,
                accounts: metas,
                data,
            },
            accounts,
            &[vault_seeds],
        )?;

        let after = token_account_amount(&ctx.accounts.vault_ata)?;
        let bought = after.saturating_sub(before);
        require!(bought > 0 && bought >= min_tokens_locked, LockError::NothingBought);
        let wsol_after = token_account_amount(&ctx.accounts.vault_wsol)?;
        require_spent(wsol_before.saturating_sub(wsol_after), spendable)?;

        // --- 4. lock ---------------------------------------------------------
        transfer_all_to_holder(&ctx, after, base_ata, expected_holder_ata, &[vault_seeds])?;
        let locked_here = token_account_amount(&ctx.accounts.holder_ata)?;
        require!(locked_here >= bought, LockError::LockFailed);

        // --- 5. unwrap the remainder, rent included, back to the vault -------
        invoke_signed(
            &anchor_spl::token::spl_token::instruction::close_account(
                &anchor_spl::token::ID,
                &quote_ata,
                vault.key,
                vault.key,
                &[],
            )?,
            &[
                ctx.accounts.vault_wsol.to_account_info(),
                vault.clone(),
                ctx.accounts.legacy_token_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // Scoped so the mutable borrow of `counter` ends before anything else
        // reads `ctx`; the values the event needs are copied out here.
        let (total_holders, total_locked) = {
            let counter = &mut ctx.accounts.counter;
            counter.next_index =
                counter.next_index.checked_add(1).ok_or(LockError::CounterFull)?;
            counter.total_holders =
                counter.total_holders.checked_add(1).ok_or(LockError::CounterFull)?;
            counter.total_locked = counter.total_locked.saturating_add(locked_here);
            (counter.total_holders, counter.total_locked)
        };

        reimburse_caller(&ctx, &[vault_seeds])?;

        emit!(LockedIn {
            mint: mint_key,
            index,
            holder: expected_holder,
            holder_ata: expected_holder_ata,
            amount: locked_here,
            total_holders,
            total_locked,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn associated_token_address(owner: &Pubkey, token_program: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}

/// A token account's balance, read without deserialising the whole thing.
///
/// Both SPL Token and Token-2022 put `amount` as a little-endian u64 at offset
/// 64 of the base account, with Token-2022's extensions appended after it, so
/// the offset holds for either. anchor-spl's `token_interface` would be the
/// tidy way to do this and its token_2022 feature does not compile here.
fn token_account_amount(account: &UncheckedAccount) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, LockError::BadTokenAccount);
    Ok(u64::from_le_bytes(
        data[64..72].try_into().map_err(|_| LockError::BadTokenAccount)?,
    ))
}


/// Pay the caller back for submitting the cycle.
///
/// Through the System Program, not by editing lamports directly. The vault is
/// system-owned -- it holds no data, only SOL -- so this program may not debit
/// it by arithmetic however much it would like to: the runtime rejects that
/// with "instruction spent from the balance of an account it does not own".
/// The vault is a PDA of this program, so it can sign the transfer instead.
fn reimburse_caller(ctx: &Context<LockInCycle>, signer: &[&[&[u8]]]) -> Result<()> {
    let vault = ctx.accounts.vault.to_account_info();
    // Never at the cost of the vault's own rent exemption: an account drained
    // below it stops existing, and the next fee payment would have nowhere to
    // land. Skipping the payment is the right failure here.
    if vault.lamports() < VAULT_RENT_EXEMPT.saturating_add(MAX_CALLER_REIMBURSEMENT) {
        return Ok(());
    }
    invoke_signed(
        &system_instruction::transfer(
            vault.key,
            ctx.accounts.caller.key,
            MAX_CALLER_REIMBURSEMENT,
        ),
        &[
            vault,
            ctx.accounts.caller.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer,
    )
    .map_err(Into::into)
}

/// Move the vault's entire token balance into the holder.
///
/// Sends `amount` — the balance after the buy, not just what this cycle bought
/// — so a residue left by an earlier partially-failed attempt cannot sit in an
/// account the vault can still spend from. The vault's token account is empty
/// at the end of every cycle.
fn transfer_all_to_holder(
    ctx: &Context<LockInCycle>,
    amount: u64,
    from: Pubkey,
    to: Pubkey,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(9);
    data.push(3u8); // SPL Token / Token-2022 Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(from, false),
                AccountMeta::new(to, false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            ],
            data,
        },
        &[
            ctx.accounts.vault_ata.to_account_info(),
            ctx.accounts.holder_ata.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        signer,
    )
    .map_err(Into::into)
}

/// Create an associated token account owned by the vault, vault paying.
fn create_ata_for_vault<'info>(
    ctx: &Context<'_, '_, '_, 'info, LockInCycle<'info>>,
    ata: &UncheckedAccount<'info>,
    mint: &UncheckedAccount<'info>,
    token_program: &UncheckedAccount<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault.key(), true),
                AccountMeta::new(ata.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), false),
                AccountMeta::new_readonly(mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(token_program.key(), false),
            ],
            data: vec![1u8], // CreateIdempotent
        },
        &[
            ctx.accounts.vault.to_account_info(),
            ata.to_account_info(),
            mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
        ],
        signer,
    )
    .map_err(Into::into)
}

/// Create the holder's associated token account, with the vault paying.
///
/// `CreateIdempotent` (opcode 1) rather than `Create`, because a cycle that
/// failed after this step and before the transfer would otherwise be unable to
/// retry: the account would already exist and `Create` would abort the whole
/// instruction for ever at that index.
fn create_holder_account(ctx: &Context<LockInCycle>, signer: &[&[&[u8]]]) -> Result<()> {
    invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault.key(), true), // funder
                AccountMeta::new(ctx.accounts.holder_ata.key(), false),
                AccountMeta::new_readonly(ctx.accounts.holder.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: vec![1u8],
        },
        &[
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.holder_ata.to_account_info(),
            ctx.accounts.holder.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
        ],
        signer,
    )
    .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 8 + 32 + 1 + 1;
}

/// Everything a reader needs to check the claim, in one account per mint.
#[account]
pub struct LockCounter {
    pub mint: Pubkey,
    /// The next holder index. Only ever increases.
    pub next_index: u32,
    pub total_holders: u32,
    pub total_locked: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
impl LockCounter {
    pub const LEN: usize = 8 + 32 + 4 + 4 + 8 + 1 + 1;
}

/// Only the program's upgrade authority may create the config.
///
/// The config is a single account seeded by a constant, so whoever creates it
/// first becomes the pause admin for ever. Left open, a bot watching for new
/// deployments could take it in the seconds between `program deploy` and our
/// own setup, and hold a pause over every vault. Requiring the upgrade
/// authority's signature closes that window: before deployment nobody can call
/// this, and after `--final` nobody can either. Anchor creates `config` before
/// it checks `program_data`, but a refusal reverts the creation with it.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: this program's ProgramData account -- the address is derived
    /// here, and the bytes are read by `names_upgrade_authority`.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = names_upgrade_authority(&program_data, &admin.key())
            @ LockError::NotUpgradeAuthority
    )]
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = Config::LEN, seeds = [SEED_CONFIG], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

/// True when `program_data` is owned by the upgradeable loader and names `who`
/// as the upgrade authority.
///
/// Read by hand rather than through Anchor's `Account<ProgramData>`, which
/// deserialises with bincode and grew the binary by 68 KB -- about half a SOL
/// of permanent rent -- to read 45 bytes. The layout is loader-v3's
/// `UpgradeableLoaderState::ProgramData`: u32 tag (3), u64 slot, then an
/// Option<Pubkey> as one tag byte (1 = Some) and 32 bytes.
fn names_upgrade_authority(program_data: &AccountInfo, who: &Pubkey) -> bool {
    if *program_data.owner != anchor_lang::solana_program::bpf_loader_upgradeable::ID {
        return false;
    }
    let Ok(data) = program_data.try_borrow_data() else {
        return false;
    };
    data.len() >= 45 && data[0..4] == 3u32.to_le_bytes() && data[12] == 1 && &data[13..45] == who.as_ref()
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(address = config.admin @ LockError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct InitToken<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: seeds the counter and vault, so it cannot address another token.
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = LockCounter::LEN,
        seeds = [SEED_COUNTER, mint.key().as_ref()],
        bump,
    )]
    pub counter: Account<'info, LockCounter>,

    /// CHECK: a system-owned PDA that only holds lamports.
    #[account(mut, seeds = [SEED_VAULT, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockInCycle<'info> {
    /// Anyone. Reimbursed a capped amount for submitting, so that
    /// "permissionless" means something in practice.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: the mint being bought. It seeds the vault and counter below.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    #[account(mut, seeds = [SEED_COUNTER, mint.key().as_ref()], bump = counter.bump)]
    pub counter: Account<'info, LockCounter>,

    /// CHECK: system-owned PDA holding this mint's fee share.
    #[account(mut, seeds = [SEED_VAULT, mint.key().as_ref()], bump = counter.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: the vault's token account, address-checked in the handler. Empty
    /// at the end of every cycle.
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,

    /// CHECK: `["hold", mint, index]` for the counter's current index, derived
    /// and compared in the handler so the caller cannot choose the destination.
    /// It holds no data and signs nothing; it exists to own the account below.
    pub holder: UncheckedAccount<'info>,

    /// CHECK: the holder's token account, created here and never touched again
    /// by anything in this program. There is no instruction that can move,
    /// close or reassign it.
    #[account(mut)]
    pub holder_ata: UncheckedAccount<'info>,

    /// CHECK: pinned to pump.fun's bonding-curve program in the handler.
    pub pump_program: UncheckedAccount<'info>,

    /// CHECK: whichever token program owns the mint.
    pub token_program: UncheckedAccount<'info>,

    /// CHECK: the vault's wrapped-SOL account, address-checked in the AMM
    /// handler and closed back into the vault before that instruction ends.
    /// Unused on the bonding curve.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,

    /// CHECK: pinned to wrapped SOL; only the AMM path touches it.
    #[account(address = WSOL_MINT @ LockError::BadPumpAccounts)]
    pub wsol_mint: UncheckedAccount<'info>,

    /// CHECK: legacy SPL Token, which is what wrapped SOL is. Distinct from
    /// `token_program`, which is Token-2022 for a pump.fun v2 mint.
    #[account(address = anchor_spl::token::ID @ LockError::BadPumpAccounts)]
    pub legacy_token_program: UncheckedAccount<'info>,

    /// CHECK: pinned to the associated-token program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM @ LockError::BadPumpAccounts)]
    pub associated_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------

#[event]
pub struct TokenRegistered {
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct LockedIn {
    pub mint: Pubkey,
    pub index: u32,
    pub holder: Pubkey,
    pub holder_ata: Pubkey,
    pub amount: u64,
    pub total_holders: u32,
    pub total_locked: u64,
}

#[error_code]
pub enum LockError {
    #[msg("new cycles are paused")]
    Paused,
    #[msg("only the admin may do that")]
    NotAdmin,
    #[msg("this counter belongs to a different mint")]
    WrongMint,
    #[msg("too little collected to be worth a cycle")]
    CycleTooSmall,
    #[msg("the holder account is not the one this cycle must use")]
    WrongHolder,
    #[msg("the buy must be routed through pump.fun")]
    NotPumpProgram,
    #[msg("wrong number or arrangement of pump.fun accounts")]
    BadPumpAccounts,
    #[msg("the buy names a different mint than this vault")]
    BuyMintMismatch,
    #[msg("the buy must be made by this vault")]
    BuyerMismatch,
    #[msg("the buy produced no tokens to lock")]
    NothingBought,
    #[msg("the tokens did not reach the holder")]
    LockFailed,
    #[msg("that is not a token account")]
    BadTokenAccount,
    #[msg("no further holders can be created")]
    CounterFull,
    #[msg("the buy spent less than half of what this cycle could spend")]
    UnderSpent,
    #[msg("only the program's upgrade authority may create the config")]
    NotUpgradeAuthority,
}
