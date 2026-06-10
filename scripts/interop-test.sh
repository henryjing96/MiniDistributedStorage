#!/usr/bin/env bash
#
# Cross-implementation interop test for MiniDSS.
#
# Verifies that the Go and TypeScript implementations speak the exact same
# wire protocol by running mixed topologies:
#
#   Scenario 1: Go dssctl  ->  TS coordinator  ->  Go storage nodes
#   Scenario 2: TS client  ->  Go coordinator  ->  TS storage nodes
#
# Between them, every cross-language boundary is exercised in both directions:
#   - client  <-> coordinator   (REST /v1/files API)
#   - coordinator <-> storage   (content-addressed /blocks/{sha256} API)
#
# Exit code 0 = all scenarios passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_DIR="$ROOT/go"
TS_DIR="$ROOT/ts"
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log()  { printf '\033[1;34m[interop]\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; exit 1; }

# ---- build ----
log "building Go binaries..."
( cd "$GO_DIR"
  go build -o "$WORK/go-storaged"     ./cmd/storaged
  go build -o "$WORK/go-coordinatord" ./cmd/coordinatord
  go build -o "$WORK/go-dssctl"       ./cmd/dssctl )

log "building TypeScript..."
( cd "$TS_DIR"
  if [ ! -d node_modules ]; then npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1; fi
  npm run build >/dev/null )

TS_STORAGE="node $TS_DIR/dist/src/storage/main.js"
TS_COORD="node $TS_DIR/dist/src/coordinator/main.js"
TS_CLIENT="node $TS_DIR/dist/src/client/main.js"

wait_health() {
  local url="$1"
  for _ in $(seq 1 100); do
    if curl -sf "$url/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

start() { # start <logfile> <cmd...>
  local logf="$1"; shift
  "$@" >"$logf" 2>&1 &
  PIDS+=("$!")
}

# ----------------------------------------------------------------------------
# Scenario 1: Go dssctl -> TS coordinator -> Go storage nodes
# ----------------------------------------------------------------------------
scenario1() {
  log "Scenario 1: Go dssctl -> TS coordinator -> Go storage"
  local d="$WORK/s1"; mkdir -p "$d"

  start "$d/st1.log" "$WORK/go-storaged" -addr :21102 -data "$d/stor1" -id g1
  start "$d/st2.log" "$WORK/go-storaged" -addr :21103 -data "$d/stor2" -id g2
  start "$d/st3.log" "$WORK/go-storaged" -addr :21104 -data "$d/stor3" -id g3
  wait_health http://127.0.0.1:21102 || fail "go storage 1 did not come up"
  wait_health http://127.0.0.1:21103 || fail "go storage 2 did not come up"
  wait_health http://127.0.0.1:21104 || fail "go storage 3 did not come up"

  start "$d/coord.log" $TS_COORD --addr :21101 --db "$d/coord.db" \
    --nodes 'http://127.0.0.1:21102,http://127.0.0.1:21103,http://127.0.0.1:21104' \
    --replicas 2
  wait_health http://127.0.0.1:21101 || fail "TS coordinator did not come up"

  local src="$d/src.bin" out="$d/out.bin"
  head -c $((7*1024*1024+321)) /dev/urandom > "$src"
  local want; want=$(sha256sum "$src" | awk '{print $1}')

  MINIDSS_COORDINATOR=http://127.0.0.1:21101 "$WORK/go-dssctl" \
    -block-size 1048576 upload "$src" interop1.bin >/dev/null
  MINIDSS_COORDINATOR=http://127.0.0.1:21101 "$WORK/go-dssctl" \
    download interop1.bin "$out" >/dev/null
  local got; got=$(sha256sum "$out" | awk '{print $1}')
  [ "$want" = "$got" ] || fail "scenario 1 sha mismatch ($want != $got)"
  pass "round-trip sha256 matches ($want)"

  # also verify ls + rm across the boundary
  MINIDSS_COORDINATOR=http://127.0.0.1:21101 "$WORK/go-dssctl" ls | grep -q interop1.bin \
    || fail "scenario 1 ls did not show file"
  MINIDSS_COORDINATOR=http://127.0.0.1:21101 "$WORK/go-dssctl" rm interop1.bin >/dev/null
  pass "ls/rm work across Go-client <-> TS-coordinator"
}

# ----------------------------------------------------------------------------
# Scenario 2: TS client -> Go coordinator -> TS storage nodes
# ----------------------------------------------------------------------------
scenario2() {
  log "Scenario 2: TS client -> Go coordinator -> TS storage"
  local d="$WORK/s2"; mkdir -p "$d"

  start "$d/st1.log" $TS_STORAGE --addr :21112 --data "$d/stor1" --id t1
  start "$d/st2.log" $TS_STORAGE --addr :21113 --data "$d/stor2" --id t2
  start "$d/st3.log" $TS_STORAGE --addr :21114 --data "$d/stor3" --id t3
  wait_health http://127.0.0.1:21112 || fail "TS storage 1 did not come up"
  wait_health http://127.0.0.1:21113 || fail "TS storage 2 did not come up"
  wait_health http://127.0.0.1:21114 || fail "TS storage 3 did not come up"

  start "$d/coord.log" "$WORK/go-coordinatord" -addr :21111 -db "$d/coord.db" \
    -nodes 'http://127.0.0.1:21112,http://127.0.0.1:21113,http://127.0.0.1:21114' \
    -replicas 2
  wait_health http://127.0.0.1:21111 || fail "Go coordinator did not come up"

  local src="$d/src.bin" out="$d/out.bin"
  head -c $((9*1024*1024+77)) /dev/urandom > "$src"
  local want; want=$(sha256sum "$src" | awk '{print $1}')

  MINIDSS_COORDINATOR=http://127.0.0.1:21111 $TS_CLIENT \
    --block-size 1048576 upload "$src" interop2.bin >/dev/null
  MINIDSS_COORDINATOR=http://127.0.0.1:21111 $TS_CLIENT \
    download interop2.bin "$out" >/dev/null
  local got; got=$(sha256sum "$out" | awk '{print $1}')
  [ "$want" = "$got" ] || fail "scenario 2 sha mismatch ($want != $got)"
  pass "round-trip sha256 matches ($want)"

  MINIDSS_COORDINATOR=http://127.0.0.1:21111 $TS_CLIENT ls | grep -q interop2.bin \
    || fail "scenario 2 ls did not show file"
  MINIDSS_COORDINATOR=http://127.0.0.1:21111 $TS_CLIENT rm interop2.bin >/dev/null
  pass "ls/rm work across TS-client <-> Go-coordinator"
}

# ----------------------------------------------------------------------------
# Scenario 3: shared token across all components, mixed Go/TS topology
# ----------------------------------------------------------------------------
scenario3() {
  log "Scenario 3: TS client -> Go coordinator -> TS storage, with shared token"
  local d="$WORK/s3"; mkdir -p "$d"
  local TOKEN="iop-secret-token-xyz789"

  MINIDSS_TOKEN="$TOKEN" start "$d/st1.log" $TS_STORAGE --addr :21122 --data "$d/stor1" --id t1
  MINIDSS_TOKEN="$TOKEN" start "$d/st2.log" $TS_STORAGE --addr :21123 --data "$d/stor2" --id t2
  MINIDSS_TOKEN="$TOKEN" start "$d/st3.log" $TS_STORAGE --addr :21124 --data "$d/stor3" --id t3
  wait_health http://127.0.0.1:21122 || fail "TS storage 1 did not come up"
  wait_health http://127.0.0.1:21123 || fail "TS storage 2 did not come up"
  wait_health http://127.0.0.1:21124 || fail "TS storage 3 did not come up"

  MINIDSS_TOKEN="$TOKEN" start "$d/coord.log" "$WORK/go-coordinatord" -addr :21121 -db "$d/coord.db" \
    -nodes 'http://127.0.0.1:21122,http://127.0.0.1:21123,http://127.0.0.1:21124' \
    -replicas 2
  wait_health http://127.0.0.1:21121 || fail "Go coordinator did not come up"

  # Step A: client WITHOUT the token must be rejected -> 401
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:21121/v1/files")
  [ "$code" = "401" ] || fail "anon request expected 401, got $code"
  pass "anonymous request rejected with 401"

  # Step B: client WITH the token works end to end
  local src="$d/src.bin" out="$d/out.bin"
  head -c $((6*1024*1024+99)) /dev/urandom > "$src"
  local want; want=$(sha256sum "$src" | awk '{print $1}')

  MINIDSS_COORDINATOR=http://127.0.0.1:21121 MINIDSS_TOKEN="$TOKEN" $TS_CLIENT \
    --block-size 1048576 upload "$src" interop3.bin >/dev/null
  MINIDSS_COORDINATOR=http://127.0.0.1:21121 MINIDSS_TOKEN="$TOKEN" $TS_CLIENT \
    download interop3.bin "$out" >/dev/null
  local got; got=$(sha256sum "$out" | awk '{print $1}')
  [ "$want" = "$got" ] || fail "scenario 3 sha mismatch ($want != $got)"
  pass "TS-client+token <-> Go-coord+token <-> TS-storage+token round-trip"

  # Step C: storage node also enforces — direct PUT without token -> 401
  local fake; fake=$(printf 'a%.0s' $(seq 1 64))
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data 'x' \
    "http://127.0.0.1:21122/blocks/$fake")
  [ "$code" = "401" ] || fail "direct storage anon request expected 401, got $code"
  pass "storage node rejects anonymous request with 401"

  MINIDSS_COORDINATOR=http://127.0.0.1:21121 MINIDSS_TOKEN="$TOKEN" $TS_CLIENT \
    rm interop3.bin >/dev/null
}

scenario1
scenario2
scenario3
log "all interop scenarios passed"
