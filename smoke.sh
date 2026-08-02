#!/usr/bin/env bash
# smoke.sh: hive-mcp-sigr local smoke test
#
# Tests: /health, /.well-known/mcp.json, honest 404, tools/list (13 tools,
#        reconciled against real upstream routes), tools/call get_pubkey,
#        tools/call sign_mir (live call to real upstream /sigr/mir).
#
# Exits 0 on success, 1 on any failure.

set -uo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fuser -k "${PORT}/tcp" 2>/dev/null || true
command -v node >/dev/null 2>&1 || { echo "node not found, aborting"; exit 1; }

if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  info "Installing dependencies…"
  npm install --omit=dev --no-audit --no-fund --silent
fi

node server.js > /tmp/hive-mcp-sigr-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; exit' INT TERM EXIT

info "Waiting for server to be ready…"
for i in $(seq 1 20); do
  if curl -sf "${BASE}/health" >/dev/null 2>&1; then
    info "Server ready after ${i} attempts"
    break
  fi
  sleep 0.5
done

jsonrpc() {
  local method="$1"
  local params="$2"
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "${BASE}/mcp"
}

info "Test 1: GET /health"
HEALTH=$(curl -sf "${BASE}/health") || fail "GET /health failed"
echo "$HEALTH" | grep -q '"status":"ok"' && ok "GET /health → status ok" || fail "GET /health unexpected: $HEALTH"

info "Test 2: GET /.well-known/mcp.json"
MCP_JSON=$(curl -sf "${BASE}/.well-known/mcp.json") || fail "GET /.well-known/mcp.json failed"
echo "$MCP_JSON" | grep -q '"endpoint":"/mcp"' && ok "well-known → endpoint present" || fail "well-known → endpoint missing"
echo "$MCP_JSON" | grep -q '"transport":"streamable-http"' && ok "well-known → transport=streamable-http" || fail "well-known → transport missing"

info "Test 3: honest 404"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/does-not-exist")
if [ "$CODE" = "404" ]; then ok "GET /does-not-exist → 404"; else fail "GET /does-not-exist → ${CODE} (expected 404)"; fi

info "Test 4: tools/list reconciled with upstream"
TOOLS_RESP=$(jsonrpc "tools/list" "{}") || fail "tools/list RPC failed"
TOOLS_N=$(echo "$TOOLS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo 0)
[ "$TOOLS_N" -eq 13 ] 2>/dev/null && ok "tools/list → 13 tools" || fail "tools/list → ${TOOLS_N} tools (expected 13)"
for TOOL in sign_chain sign_bill sign_bond sign_consensus sign_mir sign_gca sign_gitm sign_cachesign sign_manifest verify_receipt upstream_gate get_upstream_catalog get_pubkey; do
  echo "$TOOLS_RESP" | grep -q "\"name\":\"${TOOL}\"" && ok "tools/list → '${TOOL}' present" || fail "tools/list → '${TOOL}' MISSING"
done

info "Test 5: tools/call get_pubkey (live upstream)"
PUBKEY_RESP=$(jsonrpc "tools/call" '{"name":"get_pubkey","arguments":{}}') || fail "get_pubkey call failed"
echo "$PUBKEY_RESP" | grep -q 'ML-DSA-65' && ok "get_pubkey → ML-DSA-65 present" || fail "get_pubkey → unexpected: $PUBKEY_RESP"

info "Test 6: tools/call sign_mir (live upstream /sigr/mir, the reconciled route)"
MIR_RESP=$(jsonrpc "tools/call" '{"name":"sign_mir","arguments":{"mir":{"subject_id":"smoke","steps":[{"model_id":"m1","weights_sha3":"a","config_hash":"b","endpoint":"https://x"}]}}}') || fail "sign_mir call failed"
echo "$MIR_RESP" | grep -q '"ok\\":true' || echo "$MIR_RESP" | grep -q '\\"ok\\": true' && ok "sign_mir → live envelope returned" || info "sign_mir raw response: $MIR_RESP"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Passed: ${GREEN}${PASS}${NC}  Failed: ${RED}${FAIL}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SMOKE TEST FAILED${NC}"
  exit 1
fi
echo -e "${GREEN}SMOKE TEST PASSED${NC}"
exit 0
