# Verify Locked In yourself

Each check needs only a Solana RPC endpoint and public tools. The token mint is `E8M3Xr22f9hmzW3JXdqvJyjPzUfUaBp27GQq3ziLpump`; use it wherever `<MINT>` appears.

## 1. The deployed program is this source

The program is built inside the pinned `solanafoundation/solana-verifiable-build` image for Solana 2.1.21 (see `[workspace.metadata.cli]` in `Cargo.toml`). The build is deterministic, so rebuilding gives the same bytes.

```bash
cargo install solana-verify --version 0.5.2 --locked
solana-verify verify-from-repo -um --program-id EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J \
  https://github.com/kryptoxerk-dot/lockedin --commit-hash ca4700bb2f145433df86429827981b76325746df --library-name lockedin
```

This rebuilds the program and compares its hash with the one on mainnet. The same verification was submitted to OtterSec's registry before the program was made immutable, so Solscan and Solana Explorer show the program as verified. The GitHub Actions workflow in `.github/workflows/verifiable-build.yml` runs the same build in public on every change.

## 2. Nobody can change the program

```bash
solana program show EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J -um
```

`Authority: none` means no upgrade is possible, by anyone, ever.

## 3. Nobody can pause it

The config PDA `["cfg"]` stores `admin` (32 bytes after the 8-byte discriminator) then `paused` (1 byte). After launch the admin is `11111111111111111111111111111111`, which has no private key, and `paused` is 0. `set_paused` requires the admin's signature, so it can never be called again.

## 4. The fee split is 50/50 and frozen

The token's pump.fun fee-sharing config lists exactly two shareholders: the vault PDA `["lockv", <MINT>]` under the program, and the creator wallet, at 5,000 bps each. Its admin is revoked after the one allowed update, so the shares can never change. The website reads and shows this live.

## 5. Every lock is real

For lock number *n*:

```js
import { PublicKey } from "@solana/web3.js";
const program = new PublicKey("EMs5GHLJ1MMGrvVxVQKLjpSXpmkeNfc2gXjvAVEhBr2J");
const mint = new PublicKey("<MINT>");
const i = Buffer.alloc(4); i.writeUInt32LE(n);
const holder = PublicKey.findProgramAddressSync([Buffer.from("hold"), mint.toBuffer(), i], program)[0];
PublicKey.isOnCurve(holder.toBytes()); // false: no private key exists
```

Its Token-2022 associated token account holds the locked tokens. The token accounts have no delegate and no close authority, and the mint has no mint or freeze authority. The sum over all holders equals `total_locked` in the counter PDA `["cnt", <MINT>]`.

## 6. The tests

`docs/readiness/` holds the output of the last full run against a local validator that cloned mainnet's pump.fun, PumpSwap and fee programs. It covers the bonding curve, attack attempts, PumpSwap, the full automatic flow through a real graduation, the dashboard, and a rehearsal of the deploy-and-lock sequence. Every address in those logs belongs to a disposable test chain.
