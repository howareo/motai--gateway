#!/usr/bin/env bash
# Formal cutover: the Motai gateway trial takes over 3001/8787 from the old New API stack.
# Usage on the lab host as root:
#   motai-cutover.sh preflight                                   # read-only checks, changes nothing
#   motai-cutover.sh --preflight <port> --token-file <file>      # Claude Code smoke test against <port> only, changes nothing; exit 0 = all passed
#   motai-cutover.sh cutover --token-file <file>                 # tail import -> stop old console -> wallet handoff -> backup -> stop old New API -> take ports -> smoke test
#   motai-cutover.sh check-token --token-file <file>             # validate the token file only
# Prefer motai-cutover-detached.sh for the real cutover so an ssh drop cannot kill it half way.
# The token file must be a regular file owned by root with mode 0600; the token is never put on a command line, in the environment or in the log.
# Old postgres/redis keep running and old containers are only stopped, so motai-rollback.sh can restore them.
# Auto rollback: once cutover reaches phase 2 (first change to production state) any failure, signal or failed
# smoke test runs motai-rollback.sh "$BACKUP". Exit code 99 means the rollback itself failed (see AUTO-ROLLBACK FAILED in the log).
# A rollback that exits 10 (done with warnings) counts as success and is logged as AUTO-ROLLBACK OK WITH WARNINGS.
# Phase 4 writes $BACKUP/wallet-handed-over; without it the rollback leaves the old console's wallet alone.
set -Eeuo pipefail
umask 077
# MOTAI_* overrides exist so the stubbed tests can run off the lab host; the defaults are the production paths.
NEW=${MOTAI_NEW_DIR:-/opt/apps/motai-trial-20261028}
OLD=${MOTAI_OLD_COMPOSE_DIR:-/opt/apps/new-api-ops/compose}
OLD_STATE=${MOTAI_OLD_STATE_DIR:-/opt/apps/new-api-ops/state/console}
OLD_PROJECT=new-api-ops-shadow
STAMP=$(date +%Y%m%dT%H%M%S%z)
BACKUP=${MOTAI_BACKUP_ROOT:-/var/backups/services}/new-api-ops-cutover-$STAMP
ROLLBACK_SCRIPT=${MOTAI_ROLLBACK_SCRIPT:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/motai-rollback.sh}
SMOKE_DEADLINE=${MOTAI_SMOKE_DEADLINE_SECONDS:-120}
SMOKE_RETRY_SLEEP=${MOTAI_SMOKE_RETRY_SLEEP:-3}
SMOKE_CALL_TIMEOUT=${MOTAI_SMOKE_CALL_TIMEOUT:-20}
# Models Claude Code actually gets served; both also get a streaming /v1/messages call.
# claude-haiku-4-5 / claude-fable-5-1 are configured in Claude Code but no channel serves them (old 3001 answers 503 too), so they are not a cutover gate.
SMOKE_MODELS=(claude-opus-5.5 claude-sonnet-5.5)
SMOKE_STREAM_MODELS=(claude-opus-5.5 claude-sonnet-5.5)
TOKEN=""        # shell variable only, never exported
ARMED=0         # 1 from the first phase that changes production state
ROLLED=0
LAST_ERR=""
phase() { echo; echo "=== $(date +%H:%M:%S) $*"; }
log() { echo "[$(date +%FT%T%z)] $*"; }
usage() {
  echo "usage: $0 preflight | $0 cutover --token-file <file> | $0 --preflight <port> --token-file <file> | $0 check-token --token-file <file>" >&2
  exit 2
}

check_token_file() {
  local f=${1:-} meta
  [ -n "$f" ] || { log "token file path required"; return 1; }
  if [ ! -f "$f" ] || [ -L "$f" ]; then log "token file $f is missing, not a regular file, or a symlink"; return 1; fi
  meta=$(stat -c '%u %a' "$f") || return 1
  if [ "$meta" != "0 600" ]; then log "token file $f must be owned by root with mode 0600 (found uid/mode: $meta)"; return 1; fi
}

load_token() {
  local t re='^[A-Za-z0-9._~+/=-]+$'
  check_token_file "${1:-}" || return 1
  t=$(head -n 1 "$1" | tr -d '\r')
  if [ "${#t}" -lt 8 ] || [ "${#t}" -gt 512 ] || ! [[ $t =~ $re ]]; then log "token file $1 does not start with a single token of the expected characters"; return 1; fi
  TOKEN=$t
}

# One Claude Code style call against 127.0.0.1:<port>. The token reaches curl through a config on stdin,
# so it is not visible in argv. The log line holds only model, call kind, status code and elapsed time.
smoke_call() {
  local port=$1 model=$2 kind=$3 path body out meta code ctype resp t0 t1 result=fail reason=""
  case $kind in
    count) path=/v1/messages/count_tokens; body='{"model":"'$model'","messages":[{"role":"user","content":"ping"}]}' ;;
    stream) path=/v1/messages; body='{"model":"'$model'","max_tokens":1,"stream":true,"messages":[{"role":"user","content":"ping"}]}' ;;
    *) return 2 ;;
  esac
  t0=$(date +%s%N)
  out=$(printf 'header = "Authorization: Bearer %s"\nheader = "x-api-key: %s"\n' "$TOKEN" "$TOKEN" |
    curl -sS -K - --max-time "$SMOKE_CALL_TIMEOUT" -X POST "http://127.0.0.1:$port$path" \
      -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
      --data-binary "$body" -w '\n%{http_code} %{content_type}' 2>/dev/null) || true
  t1=$(date +%s%N)
  meta=${out##*$'\n'}
  resp=${out%$'\n'*}
  code=${meta%% *}
  ctype=${meta#* }
  [[ $code =~ ^[0-9]{3}$ ]] || code=000
  if [ "$code" != 200 ]; then
    reason=http-status
  elif [ "$kind" = count ]; then
    if [[ $resp == *'"input_tokens"'* ]]; then result=ok; else reason=no-input_tokens; fi
  elif [[ $ctype != text/event-stream* ]]; then
    reason=not-event-stream
  elif [[ $resp != *message_stop* ]]; then
    reason=no-message_stop
  else
    result=ok
  fi
  log "smoke port=$port model=$model kind=$kind status=$code ms=$(((t1 - t0) / 1000000)) result=$result${reason:+ reason=$reason}"
  [ "$result" = ok ]
}

# One pass over every model; fails if any single call failed.
smoke_round() {
  local port=$1 m bad=0
  for m in "${SMOKE_MODELS[@]}"; do smoke_call "$port" "$m" count || bad=1; done
  for m in "${SMOKE_STREAM_MODELS[@]}"; do smoke_call "$port" "$m" stream || bad=1; done
  return $bad
}

# Repeat full passes until one is clean or SMOKE_DEADLINE seconds have passed.
smoke_until_pass() {
  local port=$1 attempt=0 start=$SECONDS
  while :; do
    attempt=$((attempt + 1))
    if smoke_round "$port"; then log "smoke test passed on port $port (attempt $attempt)"; return 0; fi
    if [ $((SECONDS - start)) -ge "$SMOKE_DEADLINE" ]; then log "smoke test still failing on port $port after ${SMOKE_DEADLINE}s (attempt $attempt)"; return 1; fi
    sleep "$SMOKE_RETRY_SLEEP"
  done
}

arm_rollback() { ARMED=1; log "auto-rollback armed: any failure from here runs $ROLLBACK_SCRIPT $BACKUP"; }

auto_rollback() {
  local rrc=0
  ROLLED=1
  log "AUTO-ROLLBACK START ($1)"
  bash "$ROLLBACK_SCRIPT" "$BACKUP" || rrc=$?
  if [ "$rrc" -eq 0 ]; then
    log "AUTO-ROLLBACK OK: old New API restored on 3001/8787, gateway trial back on 3101/8788"
    return 0
  fi
  if [ "$rrc" -eq 10 ]; then
    log "AUTO-ROLLBACK OK WITH WARNINGS: old New API restored, but something optional was skipped; read the WARNING lines above"
    return 0
  fi
  log "AUTO-ROLLBACK FAILED (rollback exit $rrc): 3001/8787 may be down, run by hand: bash $ROLLBACK_SCRIPT $BACKUP"
  return 1
}

on_exit() {
  local rc=$?
  trap - EXIT ERR
  trap '' INT TERM HUP
  set +e
  if [ "$rc" -ne 0 ] && [ "$ARMED" = 1 ] && [ "$ROLLED" = 0 ]; then
    log "cutover failed (exit $rc${LAST_ERR:+, last error: $LAST_ERR}) after production state was changed"
    if auto_rollback "exit $rc"; then exit "$rc"; else exit 99; fi
  elif [ "$rc" -ne 0 ]; then
    log "cutover failed (exit $rc${LAST_ERR:+, last error: $LAST_ERR}) before production state was changed; nothing to roll back"
  fi
  exit "$rc"
}
on_signal() { log "received signal $1"; exit "$2"; }

preflight_smoke() {
  [[ $PORT =~ ^[0-9]{1,5}$ ]] || { echo "invalid port: $PORT" >&2; exit 2; }
  load_token "$TOKEN_FILE" || exit 3
  log "smoke-only preflight against 127.0.0.1:$PORT (nothing is changed)"
  if smoke_round "$PORT"; then log "preflight smoke PASS"; else log "preflight smoke FAIL"; exit 1; fi
}
health() { curl -sS --max-time 10 "http://127.0.0.1:$1/api/healthz"; }
core_status() { curl -sS --max-time 10 -H "Authorization: Bearer $(cat "$NEW/config/management.key")" http://127.0.0.1:3102/internal/v1/status; }

preflight() {
  phase preflight
  core_status | python3 -c 'import json,sys; s=json.load(sys.stdin); print("core ready", s["ready"], "serving", s["serving_gen"]); assert s["ready"]'
  health 8788 | python3 -c 'import json,sys; h=json.load(sys.stdin); l=h.get("legacy"); print("console ok", h["ok"], "legacy", l); assert h["ok"] and l and l["enabled"]'
  for c in "$OLD_PROJECT-new-api-1" "$OLD_PROJECT-console-1" "$OLD_PROJECT-postgres-1"; do
    docker inspect --format '{{.Name}} {{.State.Status}}' "$c"
  done
  ss -ltnp | grep -E ':(3001|8787) ' || true
  test -f "$OLD_STATE/wallet-credentials.json" && test -f "$OLD_STATE/wallet-state.json"
  df -h /var/backups | tail -n 1
  test ! -e "$BACKUP"
  echo "preflight ok"
}

wait_legacy_complete() {
  for i in $(seq 1 180); do
    if health 8788 | python3 -c 'import json,sys; l=json.load(sys.stdin)["legacy"]; print("legacy", l["coveredSeconds"], "/", l["to"]-l["from"], "err", l["lastError"]); sys.exit(0 if l["complete"] else 1)'; then return 0; fi
    sleep 10
  done
  echo "legacy import did not complete in 30 minutes" >&2; return 1
}

cutover() {
  load_token "$TOKEN_FILE" || exit 3
  trap on_exit EXIT
  trap 'LAST_ERR="line $LINENO: $BASH_COMMAND"' ERR
  trap 'on_signal INT 130' INT
  trap 'on_signal TERM 143' TERM
  trap 'on_signal HUP 129' HUP
  preflight
  cd "$NEW"
  install -d -m 700 "$BACKUP"
  cp compose.yaml "$BACKUP/trial-compose.before-cutover.yaml"; cp .env "$BACKUP/trial-env.before-cutover"

  phase "1/7 import history tail up to now"
  to=$(date +%s)
  sed -i "s/^MOTAI_LEGACY_TO=.*/MOTAI_LEGACY_TO=$to/" .env
  docker compose --env-file .env up -d console 2>&1 | tail -n 1
  sleep 5; wait_legacy_complete

  phase "2/7 stop old console (wallet single writer)"
  arm_rollback
  # Plain docker stop: the old compose file needs secrets env to interpolate, and stop must not recreate anything.
  docker stop -t 30 "$OLD_PROJECT-console-1"

  phase "3/7 back up old database, console state and compose"
  docker exec "$OLD_PROJECT-postgres-1" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/old-new-api.pgdump"
  test -s "$BACKUP/old-new-api.pgdump"
  tar -C "$(dirname "$OLD_STATE")" -cf "$BACKUP/old-console-state.tar" "$(basename "$OLD_STATE")"
  tar -C "$OLD" -cf "$BACKUP/old-compose.tar" .
  (cd "$BACKUP" && sha256sum old-new-api.pgdump old-console-state.tar old-compose.tar > SHA256SUMS && cat SHA256SUMS)

  phase "4/7 hand wallet, pricing and multipliers to the new console"
  for f in wallet-credentials.json wallet-state.json cost-rules.json model-pricing.json new-api-pricing-sync.json; do
    install -m 600 -o 10001 -g 10001 "$OLD_STATE/$f" "console/state/$f"
  done
  # From here the new console owns the wallet; motai-rollback.sh reads this marker to copy its wallet files back.
  date +%FT%T%z > "$BACKUP/wallet-handed-over"

  phase "5/7 stop old New API (postgres/redis keep running)"
  docker stop -t 60 "$OLD_PROJECT-new-api-1"

  phase "6/7 take ports 3001/8787 and enable upstream automation"
  python3 - compose.yaml <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1]); text = path.read_text()
for old, new in [('      - "3101:3001"\n', '      - "3001:3001"\n      - "3101:3001"\n'),
                 ('      - "8788:8787"\n', '      - "8787:8787"\n      - "8788:8787"\n'),
                 ('      MOTAI_GATEWAY_UPSTREAM_AUTOMATION: disabled\n', '      MOTAI_GATEWAY_UPSTREAM_AUTOMATION: enabled\n')]:
    assert text.count(old) == 1, old
    text = text.replace(old, new)
path.write_text(text)
PY
  docker compose --env-file .env config --quiet
  docker compose --env-file .env up -d core console 2>&1 | tail -n 2

  phase "7/7 verify"
  for i in $(seq 1 60); do curl -sf --max-time 5 http://127.0.0.1:3001/healthz >/dev/null && health 8787 >/dev/null && break; sleep 1; done
  curl -sS http://127.0.0.1:3001/healthz; echo
  core_status | python3 -c 'import json,sys; s=json.load(sys.stdin); print("core ready", s["ready"], "serving", s["serving_gen"]); assert s["ready"]'
  health 8787 | python3 -c 'import json,sys; h=json.load(sys.stdin); print("console ok", h["ok"], "legacy complete", h["legacy"]["complete"]); assert h["ok"]'
  curl -sS http://127.0.0.1:8787/api/gateway/status | grep -oE '"upstreamAutomation":\{[^}]*\}'
  ss -ltnp | grep -E ':(3001|8787|3101|8788) '
  phase "7/7 smoke test with the caller token on 3001 (up to ${SMOKE_DEADLINE}s, then auto rollback)"
  smoke_until_pass 3001 || { log "smoke test failed, rolling back"; exit 1; }
  echo "backup: $BACKUP"
  echo "cutover done; rollback: gateway/build/motai-rollback.sh $BACKUP"
}

MODE="" PORT="" TOKEN_FILE=""
while [ $# -gt 0 ]; do
  case $1 in
    preflight|cutover|check-token) [ -z "$MODE" ] || usage; MODE=$1; shift ;;
    --preflight) [ $# -ge 2 ] && [ -z "$MODE" ] || usage; MODE=smoke-preflight; PORT=$2; shift 2 ;;
    --token-file) [ $# -ge 2 ] || usage; TOKEN_FILE=$2; shift 2 ;;
    *) usage ;;
  esac
done
case $MODE in
  preflight) preflight ;;
  cutover) [ -n "$TOKEN_FILE" ] || usage; cutover ;;
  check-token) [ -n "$TOKEN_FILE" ] || usage; load_token "$TOKEN_FILE" || exit 3 ;;
  smoke-preflight) [ -n "$TOKEN_FILE" ] || usage; preflight_smoke ;;
  *) usage ;;
esac
