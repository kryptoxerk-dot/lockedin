# How Locked In works

## The pieces

| Account | Address | What it is |
|---|---|---|
| Program | `EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J` | The mechanism. Immutable after launch. |
| Buyback vault | PDA `["lockv", mint]` | A plain SOL account that receives 50% of creator fees. Only the program can spend from it, and only on a cycle. |
| Counter | PDA `["cnt", mint]` | Next lock number, number of holders and total tokens locked. |
| Holder *n* | PDA `["hold", mint, n as u32 little-endian]` | The *n*th locked wallet. Off the ed25519 curve, so no private key exists for it. |
| Config | PDA `["cfg"]` | One flag (paused) and its admin. The admin is set to `11111111111111111111111111111111` before launch, which nobody can sign for. |

## Launch

`scripts/launch.mjs` sends **one** transaction that:

1. creates the token on pump.fun,
2. creates its fee-sharing config with two shareholders, the vault (5,000 bps) and the creator wallet (5,000 bps), and freezes it (pump.fun allows exactly one share update, after which the config can never be edited),
3. makes the 2 SOL dev buy.

If any step fails, all of it reverts. Because the dev buy is inside the creation transaction, nobody can buy before it. The dev buy's own creator fee is split 50/50 like every other trade.

The script then registers the mint with the program, which creates the counter and funds the vault's rent, and builds an address lookup table so a cycle still fits in one transaction after graduation.

## A cycle

Anyone can submit one. Our keeper (`scripts/keeper.mjs`) does it automatically, every minute, when there is enough to spend.

1. **Distribute fees.** pump.fun holds creator fees until someone calls its permissionless distribute instruction; that sends each shareholder its half.
2. **Reserve and cap.** The program sets aside the vault's own rent, rent for the new holder's token account, and the 0.00005 SOL submitter fee. What is left must be at least 0.02 SOL, or the cycle is refused. The cycle's budget is that amount, capped at 0.2% of the market's SOL reserve, which the program reads from the curve or pool account itself. The cap means a caller cannot make the vault buy enough at once to profit from sandwiching it. Anything above the cap waits for the next cycle.
3. **Buy.** The vault buys $LOCKEDIN on pump.fun's bonding curve, or on the canonical PumpSwap pool once the token has graduated. The program re-derives the pool itself rather than trusting the caller, and checks that the buyer is the vault and the token is this mint.
4. **Spend check.** The buy must spend at least 65% of the budget. Otherwise a caller could ask for one token and make the vault pay rent for a near-empty holder.
5. **Lock.** The vault's entire token balance moves to holder *n*. The program derives holder *n* itself, so the caller cannot choose where the tokens go.
6. **Count.** The counter records the new holder and the amount.

All six happen in one instruction. A purchase never sits anywhere it could be sold from.

## Why "holders", not "people"

The counter counts funded keyless addresses created by the mechanism. Other trackers count holders their own way. One lock is one address, not one person.

## What it does not do

- It does not burn. Locked tokens stay in the supply, held by addresses nobody controls.
- It does not pay existing holders. "Distribute" means distributing buybacks to new keyless addresses.
- It does not need the keeper or the website. If both stopped, anyone could keep running cycles with the same instruction.
