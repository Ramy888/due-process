#!/usr/bin/env bash
# One command once the desk wallet is funded: deploy DeskLedger + ACE policies + $FROG on Base Sepolia, point the CRE
# workflows at it, and give each trader test USDC for x402 fees. Prints addresses only, never keys.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export PATH="$HOME/.local/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
# CRE simulation (mock) forwarder for ethereum-testnet-sepolia-base-1, from `cre workflow supported-chains`
FORWARDER=0x82300bd7c3958625581cc2f77bc6464dcecdf3e5
TRADER_USDC="${TRADER_USDC:-0.5}"
DESK=$(cast wallet address --private-key "$DESK_PRIVATE_KEY")

eth_wei=$(cast balance "$DESK" --rpc-url "$RPC")
usdc_e6=$(cast call "$USDC" "balanceOf(address)(uint256)" "$DESK" --rpc-url "$RPC" | awk '{print $1}')
need_usdc_e6=$(python3 -I -c "print(6_000_000 + 5 * round(float('$TRADER_USDC') * 1e6))")
echo "desk $DESK: $(cast from-wei "$eth_wei") ETH, $(python3 -I -c "print($usdc_e6/1e6)") USDC"
# deploy ≈ 0.0001 ETH and helper gas 0.0006 ETH at today's prices; the rest is margin for CRE report writes and gas spikes
if [ "$eth_wei" -lt 2000000000000000 ]; then echo "need at least 0.002 test ETH on the desk wallet"; exit 1; fi
if [ "$usdc_e6" -lt "$need_usdc_e6" ]; then echo "need at least $(python3 -I -c "print($need_usdc_e6/1e6)") test USDC on the desk wallet"; exit 1; fi

(cd contracts && FORWARDER=$FORWARDER BOND_TOKEN=$USDC DEPLOY_NAME=base-sepolia \
  forge script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC" --broadcast --slow 2>&1 | grep -E "DeskLedger|FROG|ONCHAIN|Error|error" )

npx -w server tsx ../scripts/sync-cre-config.ts --deployment base-sepolia
npx -w server tsx ../scripts/fund-traders.ts --deployment base-sepolia --usdc "$TRADER_USDC"

python3 -I - <<'PY'
import json
d = json.load(open("deployments/base-sepolia.json"))
for k in ("deskLedger", "frogToken", "policyEngine", "maxPolicy", "rejectPolicy"):
    print(f"{k:13} https://sepolia.basescan.org/address/{d[k]}")
PY
echo "next: CRE_CLEARANCE_TARGET=base-sepolia CRE_DESK_TARGET=base-sepolia CRE_BROADCAST=1 DEPLOYMENT=base-sepolia"
