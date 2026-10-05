#!/usr/bin/env bash
# Which --arch value means "the bytecode mainnet accepts"?
#
# Not a constant. This host was reprovisioned with the same Solana release and
# cargo-build-sbf went from taking `v0`/`v3` to taking `sbfv1`/`sbfv2` -- the
# platform-tools it downloads are versioned separately from the CLI. A build
# script with the old spelling fails outright, which is the good case; the bad
# case is a spelling that still parses and selects a newer bytecode version
# that mainnet rejects at deploy time, after the buffer is funded.
#
# So the value is read from the tool, every time, preferring the oldest
# supported version: that is the one every cluster can run.
#
#   ARCH=$(bash ops/sbf-arch.sh)
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Deliberately invalid, because the tool prints its accepted values in the
# error and does not list them in --help.
values=$(cargo-build-sbf --arch __ask__ 2>&1 | sed -n 's/.*possible values: \(.*\)\].*/\1/p' | tr -d ' ')

for candidate in v0 sbfv1 sbf v1; do
  case ",$values," in
    *",$candidate,"*) echo "$candidate"; exit 0 ;;
  esac
done

# Nothing recognised. Say so loudly rather than guessing: a wrong value here is
# a program that deploys and cannot be executed.
echo "could not work out a --arch value; cargo-build-sbf offers: ${values:-<nothing>}" >&2
exit 1
