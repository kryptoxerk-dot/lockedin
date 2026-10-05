#!/usr/bin/env bash
# A local validator holding the real pump.fun programs, cloned from mainnet.
#
# Testing against a stub of pump.fun proves nothing: the account ordering, the
# fee schedule and the graduation behaviour are exactly the parts that break,
# and a stub is written from the same misunderstanding as the code it checks.
# So the actual programs come down from mainnet and run here.
#
# pump rotates between several fee recipients, and one missing here is not
# an obvious failure: the fee creates that account fresh, below rent, and the
# whole trade reverts naming only an account index. Every recipient a buy can
# pick has to exist here.
#
# The ledger is disposable. Delete it to start clean; never point this at a
# ledger holding anything that matters.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

LEDGER="${LEDGER:-$PWD/.validator-ledger}"
if [ "$(realpath -m "$LEDGER")" != "$PWD/.validator-ledger" ]; then
  echo "Refusing a validator ledger outside this development checkout" >&2
  exit 2
fi
MINT_TO="${MINT_TO:-$(solana address)}"

# An existing ledger makes solana-test-validator ignore every --clone flag. It
# says so in one grey line among a thousand and exits zero, so adding an
# account and restarting looks like it worked and silently did not -- the tests
# then fail against accounts you are certain you cloned. The clone list is
# fingerprinted instead, and the ledger is thrown away whenever it changes.
STAMP="${LEDGER}.clone-fingerprint"
FINGERPRINT="$(grep -E -- '--clone' "$0" | sha256sum | cut -d" " -f1)"
if [ -d "$LEDGER" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$FINGERPRINT" ]; then
  echo "validator: clone list changed, resetting ledger" >&2
  rm -rf "$LEDGER"
fi
printf '%s\n' "$FINGERPRINT" > "$STAMP"

# This validator once wrote a 39 GB log and filled the host's disk, which took
# the box out rather than the test run. solana-test-validator logs at debug
# level by default and runs for days here, so the level is pinned and the file
# is rotated. Warn still carries anything that would explain a failed test --
# the suites read program logs from the RPC response, not from this file.
export RUST_LOG="${RUST_LOG:-warn}"

# The ledger is disposable and local, so there is no reason to keep history.
# Without this it also grows without limit while the host sits idle.
LEDGER_SHREDS="${LEDGER_SHREDS:-50000000}"

exec solana-test-validator \
  --quiet \
  --bind-address 127.0.0.1 \
  --limit-ledger-size "$LEDGER_SHREDS" \
  --ledger "$LEDGER" \
  --url https://api.mainnet-beta.solana.com \
  --clone-feature-set \
  --mint "$MINT_TO" \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  `# found on 2026-10-02 by diffing this list against what mainnet reports
  # today (scripts/pump-fee-recipients.mjs, scripts/amm-clone-list.mjs).
  # pump changes its fee recipients between releases; one missing here is
  # an intermittent test failure, depending on which recipient a buy draws` \
  --clone 6rVkF4HSgy1jrnC3HogfRgPHrq4CtLg5f11URpsC4i9D \
  --clone FGptqdxjahafaCzpZ1T6EDtCzYMv7Dyn5MgBLyB3VUFW \
  `# the graduated token's bonding curve. It still exists after graduation
  # and is what reports 'complete', so the cycle cannot choose a market
  # without it -- the swap SDK's account list never mentions it` \
  --clone 3wkPPCruLyuHGVJaSY21uedLxiYvsLMPGSyFQJp6qRzR \
  --clone 6coNpqRW9meDro5bYosirqEFTrHBCY3Ehfs72pLPriBG \
  --clone CPBpBQRDP66XNnnjBfqwgCfsoDhYvh5p76qauEsnXnVM \
  `# a graduated token and its PumpSwap pool for the independent AMM suite.
  # auto-flow-test also graduates and migrates a freshly created token` \
  --clone 2rynEJ7rM879q8XhVLDNrrBKFrcmTL4f2Z6nU3UvEx42 \
  --clone 5vXGW4FJ568j3Si7FfvAAQsa1KK1qrot3TVVbZNN1RFB \
  --clone 7GFUN3bWzJMKMRZ34JLsvcqdssDbXnp589SiE33KVwcC \
  --clone 8izFifHZJHQMSKRxHo7fJDEUuCdkTD5KQSf3pwMBRhnd \
  --clone BNrr3vswYEFr2txYP4tKkha8xkYv4EPrxChXhoGhotxo \
  --clone CA7v8gHfbquYXyDnDx6QxWW8hmL1H7X6Y2RYDrGLnuck \
  --clone So11111111111111111111111111111111111111112 \
  --clone kuJqFPKZH2nCmc512jsHkNwVamqwxMoLWkEBKAUes3a \
  `# pump's own config and market accounts. These are not fee recipients, so
  # they are absent from the enumerated list, and a trade fails without them` \
  --clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --clone ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw \
  --clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --clone 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx \
  --clone 7GR4twdgGFrTnSBvcqfEpx9gL2M7Kwkv5BBiw5sZ7Zwf \
  --maybe-clone Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  --maybe-clone C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw \
  --maybe-clone Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 \
  --maybe-clone GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR \
  `# every fee-related account a pump trade can pick, enumerated from
  # pump's own global config by scripts/pump-fee-recipients.mjs, rather
  # than discovered one failed trade at a time` \
  --clone 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg \
  --clone 3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR \
  --clone 463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq \
  --clone 4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH \
  --clone 4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6 \
  --clone 5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD \
  --clone 5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6 \
  --clone 5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD \
  --clone 62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV \
  --clone 6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA \
  --clone 7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ \
  --clone 7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX \
  --clone 8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR \
  --clone 8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6 \
  --clone 9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7 \
  --clone 9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz \
  --clone A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW \
  --clone AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY \
  --clone CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM \
  --clone EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL \
  --clone FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF \
  --clone FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz \
  --clone Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk \
  --clone G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP \
  --clone GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL \
  --clone GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS \
  --clone HckQ93Xqjjo8mwt5pNPWvyCTZXQZ858rvzmm7ZRrZg9t \
  --clone UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw \
  "$@"
