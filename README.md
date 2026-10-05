<p align="center"><img src="brand/lean-in-v3/exports/lean-lock-logo/logo-1024.png" width="160" alt="Locked In"></p>

# Locked In ($LOCKEDIN)

Lean forward. Lock in.

$LOCKEDIN is a pump.fun token on Solana with one mechanism: **half of every creator fee buys $LOCKEDIN and moves it to a brand-new address that has no private key.** Every buyback adds one more locked holder, counted on-chain.

This repository is the complete source of that mechanism: the on-chain program, the scripts that launch and run it, the tests, and the website at [lockedinforever.locker](https://lockedinforever.locker).

| | |
|---|---|
| Program | [`EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J`](https://explorer.solana.com/address/EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J) |
| Token mint | Published at launch |
| Website | https://lockedinforever.locker |

## How it works

1. **Trading pays creator fees.** pump.fun charges a creator fee on every trade. At creation the token's fee split is set to 50% buyback vault and 50% creator wallet, then frozen. pump.fun refuses any later change.
2. **The vault buys.** Once the vault can cover a buyback plus account rent, anyone can run a cycle. It buys $LOCKEDIN on the bonding curve, or on PumpSwap after graduation, and spends at least half of what it can.
3. **Locked in a keyless wallet.** In the same instruction the entire purchase moves to a fresh program-derived address. No private key exists for it.
4. **One more locked holder.** The on-chain counter goes up by one. Supply does not change: this is a lock, not a burn.

More detail: [docs/how-it-works.md](docs/how-it-works.md).

## What the program cannot do

- It has **no instruction that moves, withdraws or closes** anything a holder address owns. The holder seed appears in exactly one instruction: the one that creates the holder and fills it.
- It **cannot send vault SOL anywhere except a pump.fun buy of this token** (including pump.fun's own trading fees on that buy). The only other payments are rent for the new holder's token account and a fixed 0.00005 SOL to whoever submits the cycle.
- After launch it **cannot be changed**. Its upgrade authority is removed, and its pause admin is set to an address nobody can sign for, before the token is created. You can check both on-chain.

What can still go wrong, in plain words: [docs/security.md](docs/security.md).

## Verify it yourself

- **Same code as deployed:** the program is built in a pinned Docker image ([verified build](https://solana.com/docs/programs/verified-builds)), so anyone can rebuild it and compare hashes. Explorers show it as verified against this repository. Steps: [docs/verify.md](docs/verify.md).
- **Permanence:** `solana program show EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J` reports `Authority: none`.
- **Fee split:** the token's pump.fun fee-sharing config lists two shareholders at 5,000 bps each, and the config can no longer be edited.
- **Every lock:** holder addresses can be derived from the mint and the lock number, and checked one by one. The website lists them all.

## Repository

| Path | What it is |
|---|---|
| `programs/lockedin/src/lib.rs` | The on-chain program (Anchor 0.30.1). The whole mechanism is this one file. |
| `scripts/launch.mjs` | Creates the token, sets and freezes the 50/50 split, and makes the 2 SOL dev buy, all in one transaction. Then registers the mint. |
| `scripts/keeper.mjs` | Distributes creator fees and runs cycles automatically. Holds no authority; anyone can run it. |
| `scripts/program-setup.mjs` | Deploys the program, then gives up its pause admin and upgrade authority, in that order. |
| `scripts/*-test.mjs` | Test suites, run against a local validator that holds mainnet's real pump.fun programs. |
| `site/` | The website and its read-only chain API. |
| `docs/` | How it works, security notes, verification steps and saved test output. |

## Running the tests

Requires Node 20+, pnpm and the Solana CLI 2.1.x.

```bash
pnpm install
cargo build-sbf --manifest-path programs/lockedin/Cargo.toml
bash ops/validator.sh --upgradeable-program EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J target/deploy/lockedin.so $(solana address)
# in another terminal, against http://127.0.0.1:8899
node scripts/cycle-test.mjs
node scripts/adversarial-test.mjs
node scripts/amm-test.mjs
solana program set-upgrade-authority EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J --final
node scripts/auto-flow-test.mjs
node scripts/site-chain-test.mjs
```

The validator clones pump.fun, PumpSwap and the fee program from mainnet, so the tests run against the real programs rather than stand-ins. The output from the last full run is in [docs/readiness](docs/readiness).

## Disclosures

- **Dev buy:** 2 SOL, made in the same transaction that creates the token. Those tokens sit in the creator wallet and are not part of the locked total.
- **Creator fees:** the creator wallet receives the other 50%.
- This is a memecoin. Nothing here is investment advice, and nothing in this repository promises a price.

## License

[MIT](LICENSE)
