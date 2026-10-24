#!/usr/bin/env bash
# Container smoke test (ADR 0022). Brings the production compose.yaml up around a built
# image and checks what unit tests cannot see: the image as shipped, behind the same
# config Coolify runs, and the restore runbook end to end. CI runs it before pushing to
# GHCR; a failure blocks the deploy.
#
#   scripts/smoke.sh                 # builds brr-chat:smoke from the working tree first
#   SMOKE_IMAGE=brr-chat:ci scripts/smoke.sh --no-build
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

export SMOKE_IMAGE=${SMOKE_IMAGE:-brr-chat:smoke}
export SMOKE_PORT=${SMOKE_PORT:-$((20000 + RANDOM % 20000))}
# The two names Coolify fills in production.
export SERVICE_URL_BRR="http://127.0.0.1:$SMOKE_PORT"
export SERVICE_HEX_64_AUTHSECRET
SERVICE_HEX_64_AUTHSECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
# 0.001 h = 3.6 s, so a snapshot lands while the test watches.
export BACKUP_INTERVAL_HOURS=0.001
export BACKUP_KEEP=2
# Unpacked root filesystem, bytes. The binary is ~86 MB, distroless/cc ~28 MB.
IMAGE_BUDGET=${IMAGE_BUDGET:-$((120 * 1024 * 1024))}

PROJECT="brr-smoke-$$"
COMPOSE=(docker compose -p "$PROJECT" -f compose.yaml -f scripts/compose.smoke.yaml)
BASE="$SERVICE_URL_BRR"
WORK=$(mktemp -d)
FAILED=0

cleanup() {
  if [ "$FAILED" -ne 0 ]; then
    echo "--- container log ---"
    "${COMPOSE[@]}" logs --no-color 2>&1 | tail -50 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILED=1; exit 1; }

if [ "${1:-}" != "--no-build" ]; then
  docker build -q -t "$SMOKE_IMAGE" . >/dev/null
  pass "built $SMOKE_IMAGE"
fi

# 1. Image budget, measured on the exported filesystem so the image store doesn't matter.
probe=$(docker create "$SMOKE_IMAGE")
size=$(docker export "$probe" | wc -c)
docker rm "$probe" >/dev/null
[ "$size" -le "$IMAGE_BUDGET" ] || fail "image is $size B, budget $IMAGE_BUDGET B"
pass "image $((size / 1024 / 1024)) MB of $((IMAGE_BUDGET / 1024 / 1024)) MB budget"

"${COMPOSE[@]}" up -d --quiet-pull >/dev/null 2>&1 || fail "compose up"
CID=$("${COMPOSE[@]}" ps -q brr)

# 2. The Dockerfile healthcheck (the binary probing itself) reports healthy.
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CID")
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && fail "container went unhealthy"
  sleep 1
done
[ "$status" = healthy ] || fail "not healthy after 60 s (last: $status)"
pass "container healthy"

# 3. Hardening is what compose.yaml asked for.
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CID")" = true ] || fail "root filesystem is writable"
[ "$(docker inspect -f '{{.Config.User}}' "$CID")" = "65532:65532" ] || fail "not running as 65532"
[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$CID")" = "[ALL]" ] || fail "capabilities not dropped"
pass "read-only root, uid 65532, no capabilities"

# 4. Health and shell over HTTP.
[ "$(curl -fsS "$BASE/healthz")" = ok ] || fail "/healthz"
curl -fsS "$BASE/" | grep -q "<title>brr chat</title>" || fail "/ does not serve the shell"
pass "/healthz ok, / serves the shell"

# 5. Client IP comes from the proxy's entry: four signups whose spoofed left-hand entries
#    differ still share one budget (3/hour), and a different real client gets its own.
signup() { # username, x-forwarded-for -> HTTP status
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-up/email" \
    -H "Content-Type: application/json" -H "Origin: $BASE" -H "X-Forwarded-For: $2" \
    -d "{\"username\":\"$1\",\"password\":\"password1234\"}"
}
got=""
for i in 1 2 3 4; do got="$got $(signup "spoof$i" "203.0.113.$i, 198.51.100.9")"; done
[ "$got" = " 200 200 200 429" ] || fail "spoofed X-Forwarded-For changed the budget: got$got"
[ "$(signup other 198.51.100.10)" = 200 ] || fail "a second real client shared the first one's budget"
pass "rate limit keys on the proxy-appended address"

# 6. A snapshot lands in /backups, is whole, and holds the accounts just created.
sleep 6
"${COMPOSE[@]}" cp brr:/backups "$WORK/" >/dev/null 2>&1 || fail "cannot copy /backups"
snap=$(find "$WORK/backups" -name 'brr-chat-*.db' | sort | tail -1)
[ -n "$snap" ] || fail "no snapshot in /backups"
[ -z "$(find "$WORK/backups" -name '*.tmp')" ] || fail "temp file left in /backups"
users=$(bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database(process.argv[1], { readonly: true });
  if (db.query('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exit(2);
  console.log(db.query('SELECT COUNT(*) AS n FROM user').get().n);
" "$snap") || fail "snapshot fails integrity_check"
[ "$users" -ge 4 ] || fail "snapshot has $users accounts, expected at least 4"
pass "snapshot $(basename "$snap") intact with $users accounts"

# 7. SIGTERM drains and exits 0 well inside the 30 s grace period.
start=$(date +%s)
"${COMPOSE[@]}" stop brr >/dev/null 2>&1
took=$(($(date +%s) - start))
code=$(docker inspect -f '{{.State.ExitCode}}' "$CID")
[ "$code" = 0 ] || fail "exit code $code after SIGTERM"
[ "$took" -lt 10 ] || fail "stop took $took s"
pass "SIGTERM: exit 0 in ${took} s"

# 8. State survives a restart: the volume, not the container, holds the accounts.
"${COMPOSE[@]}" start brr >/dev/null 2>&1
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CID")
  [ "$status" = healthy ] && break
  sleep 1
done
[ "$status" = healthy ] || fail "not healthy after restart (last: $status)"
signin=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-in/username" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -d '{"username":"spoof1","password":"password1234"}')
[ "$signin" = 200 ] || fail "spoof1 cannot sign in after a restart (HTTP $signin)"
pass "data survives a restart (spoof1 signs in)"

# 9. Restore: the snapshot from step 6 predates "late", so after a restore "late" is gone
#    and spoof1 is back, through the same script the runbook uses. The log names the seq
#    new events continue from, so no device's cursor already sits past the restored log.
[ "$(signup late 198.51.100.12)" = 200 ] || fail "could not create the post-snapshot account"
timeout 120 scripts/restore.sh "$CID" "$snap" >"$WORK/restore.log" 2>&1 || { cat "$WORK/restore.log"; fail "restore.sh"; }
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CID")
  [ "$status" = healthy ] && break
  sleep 1
done
[ "$status" = healthy ] || fail "not healthy after restore (last: $status)"
signin_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-in/username" \
    -H "Content-Type: application/json" -H "Origin: $BASE" \
    -d "{\"username\":\"$1\",\"password\":\"password1234\"}"
}
[ "$(signin_status spoof1)" = 200 ] || fail "spoof1 missing after restore"
[ "$(signin_status late)" != 200 ] || fail "restore kept an account created after the snapshot"
grep -q "new events continue after" "$WORK/restore.log" ||
  { cat "$WORK/restore.log"; fail "restore log does not report where new events continue"; }
pass "restore.sh rolls back to the snapshot"

echo "smoke: all checks passed"
