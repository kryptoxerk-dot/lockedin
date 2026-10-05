#!/usr/bin/env bash
# Is the validator actually serving the accounts the clone list asks for?
#
# Worth its own script because the failure mode is quiet: a stale ledger makes
# every --clone a no-op, and the first sign is a test dying on an account you
# are sure you cloned.
set -uo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8899}"

echo "slot $(solana -u "$RPC" slot 2>&1)"

missing=0
for a in "$@"; do
  owner=$(solana -u "$RPC" account "$a" 2>&1 | grep -i 'Owner' | awk '{print $2}')
  if [ -z "$owner" ]; then
    echo "MISSING  $a"
    missing=$((missing + 1))
  else
    echo "present  $a  owner $owner"
  fi
done
echo "$missing missing"
exit $((missing > 0))
