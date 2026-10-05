# Security

The program becomes immutable before the token exists, so nothing in it can be patched later. This page lists what it protects, what was found and fixed before deploy, and what risk remains.

## What the program guarantees

- **Locked tokens cannot move.** Holder addresses are program-derived and off-curve, so no private key exists for them. The program signs only with the vault's seeds and never with a holder's. No instruction touches a holder account after creating it. Holder token accounts have a locked owner, no delegate and no close authority.
- **The vault can only buy this token.** Every cycle re-derives the market itself: the pump.fun bonding curve for this mint, or the canonical PumpSwap pool for this mint against SOL. It pins the buyer to the vault, the token to this mint, and the destination to the vault's own token account. The only program the caller chooses is the token program, and that must equal the mint's owner.
- **The caller cannot choose where tokens go.** Holder *n* is derived from the on-chain counter. The whole purchase moves to it in the same instruction as the buy.
- **The vault keeps itself alive.** It reserves its own rent, the new holder's rent and the 0.00005 SOL submitter fee before spending anything, and it never drops below rent exemption.
- **Nobody controls it after launch.** The upgrade authority is removed. Before that, the pause admin is set to an address nobody can sign for. Only the upgrade authority could ever create the config, which closes a front-running window between deploy and setup.

## Reviews

The program was reviewed by the team and by an independent adversarial review before deploy. Every finding below was fixed, and each fix has a test unless noted.

| Finding | Severity | Fix |
|---|---|---|
| **Sandwiching a cycle.** A caller could push the price up, run the cycle so the vault buys at that price, and sell into it, all in one transaction. With a large vault balance this pays. | Medium | Each cycle may spend at most **0.2% of the market's SOL reserve**, read on-chain from the curve or pool account. That keeps the vault's own price move (about 0.4%) below the cheapest round-trip fee (at least 0.6%), so the attack loses money however the attacker sets it up. The rest waits for the next cycle. Test: a cycle priced at the whole vault is refused, and a full sandwich against a 2 SOL vault loses the attacker money. |
| **Keeper paying the vault's rent after graduation.** The keeper pre-created the vault's wrapped-SOL account on every PumpSwap cycle. It would have run out of gas after about 44 cycles. | Medium (off-chain) | The program creates that account at the vault's expense, so the keeper no longer does. Test: a repeat PumpSwap cycle costs the keeper only transaction fees. |
| **Plain token transfer.** Token-2022 refuses the plain `Transfer` for mints with some extensions. | Low | The program uses `TransferChecked`, which works for every mint the plain form does. |
| **Minimum-spend cycles.** Anyone could run cycles that spend exactly the minimum share of their budget. | Low | The minimum share was raised from 50% to 65%. |
| **Hard-coded rent.** | Low | Rent is read from the cluster at execution. |
| **Account-count pins.** The program required today's exact number of pump.fun accounts or more. | Low | It now requires only the positions it reads. pump.fun validates its own accounts. |
| **Setup front-run.** Whoever created the config first became the pause admin. | Medium (internal review) | Only the program's upgrade authority can create it. Test: a funded stranger is refused with `NotUpgradeAuthority`. |
| **Dust cycles.** A caller could ask for one token and make the vault pay rent for an empty lock. | Medium (internal review) | The minimum-share check above. Test: a one-token buy is refused with `UnderSpent`. |
| **Holder rent varies by mint.** Token-2022 account size depends on the mint's extensions. | High (internal review) | The program reads the real size from the vault's own token account instead of assuming one. |

## Remaining risks

- **pump.fun upgrades.** The program calls pump.fun's buy instruction in today's format: its discriminator, argument layout and the account positions it checks. pump.fun has so far only ever appended accounts, which the program tolerates. If pump.fun changes the format incompatibly, cycles stop for good, and SOL arriving in the vault afterwards stays there. Tokens already locked are unaffected.
- **pump.fun is trusted with each cycle's budget.** The vault signs the buy, so a malicious or broken pump.fun upgrade could take up to one cycle's budget. This is inherent to buying on pump.fun.
- **Market risk.** Buybacks are market buys at market prices. The cap and the spend floor limit how badly a cycle can be priced, but they do not set the price.
- **No third-party audit.** The code is open, reviewed and tested against mainnet's real pump.fun programs. It has not been audited by a security firm.

## Reporting

Found something? Open an issue on this repository. The program is immutable, so a report cannot be fixed in place. It can still warn holders, and it matters for anyone building on the same pattern.
