#!/usr/bin/env bash
# Local test for motai-cutover.sh and motai-cutover-detached.sh.
# docker, curl, ss, stat, install, df, sleep and setsid are stubbed and the rollback script is a stub, so nothing
# touches a server or runs the real cutover/rollback. Run: bash gateway/build/test-motai-cutover.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CUT=$HERE/motai-cutover.sh
DET=$HERE/motai-cutover-detached.sh
W=$(mktemp -d)
REAL_PATH=$PATH
REAL_SLEEP=$(command -v sleep)
TOKEN=tok-SECRET-0123456789abcdef
PASS=0 FAIL=0
BGPIDS=()
cleanup() { local p; for p in ${BGPIDS[@]+"${BGPIDS[@]}"}; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }
trap cleanup EXIT
check() { # check <description> <command...>
  local d=$1; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "ok   $d"; else FAIL=$((FAIL + 1)); echo "FAIL $d"; fi
}
printf '%s\n' "$TOKEN" > "$W/token"
printf 'bad token with spaces\n' > "$W/badtoken"
mkdir -p "$W/bin"

cat > "$W/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$T/docker.log"
echo "docker $*" >> "$T/events.log"
# MOTAI_T_REFRESH_ON: on the first docker call containing this text, the new console "refreshes" its wallet files.
if [ -n "${MOTAI_T_REFRESH_ON:-}" ] && [[ "$*" == *"$MOTAI_T_REFRESH_ON"* ]] && [ ! -e "$T/refreshed" ]; then
  : > "$T/refreshed"
  echo REFRESHED-credentials > "$T/new/console/state/wallet-credentials.json"
  echo REFRESHED-state > "$T/new/console/state/wallet-state.json"
fi
if [ -n "${MOTAI_T_DOCKER_FAIL:-}" ] && [[ "$*" == *"$MOTAI_T_DOCKER_FAIL"* ]]; then echo "stub docker: forced failure" >&2; exit 1; fi
if [ -n "${MOTAI_T_DOCKER_FAIL_ONCE:-}" ] && [[ "$*" == *"$MOTAI_T_DOCKER_FAIL_ONCE"* ]] && [ ! -e "$T/failed-once" ]; then
  : > "$T/failed-once"; echo "stub docker: forced one-time failure" >&2; exit 1
fi
case $1 in
  exec) echo "PGDMP-stub" ;;
  inspect)
    if [[ "$*" == *"{{.State.Running}}"* ]]; then
      if [ -n "${MOTAI_T_CONSOLE_STUCK:-}" ]; then echo true; else echo false; fi
    else echo "/stub running"; fi ;;
  compose) if [[ "$*" == *"ps -q console"* ]]; then echo stub-console-cid; else echo "stub docker ok"; fi ;;
  *) echo "stub docker ok" ;;
esac
EOF
cat > "$W/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$T/curl.log"
env | grep -v MOTAI_T_EXPECT > "$T/curl-env.log"
url="" wfmt="" stdin="" args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in http://*) url=${args[i]} ;; -w) wfmt=1 ;; -K) stdin=$(cat) ;; esac
done
path=$(echo "$url" | sed -E 's#^http://127\.0\.0\.1:[0-9]+##')
port=$(echo "$url" | sed -E 's#^http://127\.0\.0\.1:([0-9]+).*#\1#')
code=200 ct=application/json
case $path in
  /v1/*)
    n=$(cat "$T/v1.count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$T/v1.count"
    fail=0
    [ "${MOTAI_T_SMOKE_FAIL:-}" = always ] && fail=1
    [ -n "${MOTAI_T_SMOKE_FAIL_FIRST:-}" ] && [ "$n" -le "$MOTAI_T_SMOKE_FAIL_FIRST" ] && fail=1
    [[ $stdin == *"Authorization: Bearer $MOTAI_T_EXPECT"* && $stdin == *"x-api-key: $MOTAI_T_EXPECT"* ]] || fail=1
    if [ $fail = 1 ]; then body='{"error":"stub"}'; code=503
    elif [ "$path" = /v1/messages/count_tokens ]; then body='{"input_tokens":1}'
    else body=$'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n'; ct='text/event-stream; charset=utf-8'; fi ;;
  /internal/v1/status) body='{"ready":true,"serving_gen":1}' ;;
  /api/healthz) body='{"ok":true,"legacy":{"enabled":true,"complete":true,"coveredSeconds":10,"from":0,"to":10,"lastError":null}}' ;;
  /api/gateway/status) body='{"upstreamAutomation":{"enabled":true}}' ;;
  *) body=ok ;;
esac
printf '%s' "$body"
[ -n "$wfmt" ] && printf '\n%s %s' "$code" "$ct"
exit 0
EOF
cat > "$W/bin/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 4096 0.0.0.0:3001 users:(("docker-proxy"))\nLISTEN 0 4096 0.0.0.0:8787 x\nLISTEN 0 4096 0.0.0.0:3101 x\nLISTEN 0 4096 0.0.0.0:8788 x\n'
EOF
cat > "$W/bin/df" <<'EOF'
#!/usr/bin/env bash
echo "Filesystem Size Used Avail Use% Mounted"; echo "/dev/stub 100G 1G 99G 1% /var/backups"
EOF
cat > "$W/bin/stat" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -c ] && [ "${2:-}" = '%u %a' ]; then
  case $3 in *badmeta*) echo "1000 644" ;; *) echo "0 600" ;; esac
else
  exec "$REAL_STAT" "$@"
fi
EOF
cat > "$W/bin/install" <<'EOF'
#!/usr/bin/env bash
dir="" ; pos=()
while [ $# -gt 0 ]; do
  case $1 in -d) dir=1; shift ;; -m|-o|-g) shift 2 ;; *) pos+=("$1"); shift ;; esac
done
if [ -n "$dir" ]; then mkdir -p "${pos[@]}"; else echo "install-to ${pos[1]}" >> "$T/events.log"; cp "${pos[0]}" "${pos[1]}"; fi
EOF
cat > "$W/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exec "$REAL_SLEEP" 0.05
EOF
cat > "$W/bin/setsid" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
cat > "$W/rollback-stub.sh" <<'EOF'
#!/usr/bin/env bash
echo "rollback called with: $*" >> "$T/rollback.log"
exit "${MOTAI_T_ROLLBACK_RC:-0}"
EOF
chmod +x "$W"/bin/* "$W/rollback-stub.sh"
export REAL_STAT=$(command -v stat) REAL_SLEEP

CASE=0
new_case() { # sets T and creates a fresh fake lab host under it
  CASE=$((CASE + 1)); T=$W/case$CASE; export T
  mkdir -p "$T/new/config" "$T/new/console/state" "$T/oldstate" "$T/oldcompose" "$T/backups"
  printf 'MOTAI_LEGACY_TO=1\nOTHER=keep\n' > "$T/new/.env"
  printf 'services:\n  core:\n    ports:\n      - "3101:3001"\n      - "8788:8787"\n    environment:\n      MOTAI_GATEWAY_UPSTREAM_AUTOMATION: disabled\n' > "$T/new/compose.yaml"
  echo k > "$T/new/config/management.key"
  for f in wallet-credentials wallet-state cost-rules model-pricing new-api-pricing-sync; do echo "OLD-$f" > "$T/oldstate/$f.json"; done
  echo c > "$T/oldcompose/compose.yaml"
  unset MOTAI_T_DOCKER_FAIL MOTAI_T_SMOKE_FAIL MOTAI_T_SMOKE_FAIL_FIRST MOTAI_T_ROLLBACK_RC MOTAI_T_REFRESH_ON MOTAI_T_DOCKER_FAIL_ONCE MOTAI_T_CONSOLE_STUCK
}
# run <extra env assignments...> -- <script args...>; sets RC and OUT (stdout+stderr, also in $T/out.log)
run() {
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  env PATH="$W/bin:$REAL_PATH" T="$T" MOTAI_T_EXPECT="$TOKEN" MOTAI_NEW_DIR="$T/new" MOTAI_OLD_COMPOSE_DIR="$T/oldcompose" \
    MOTAI_OLD_STATE_DIR="$T/oldstate" MOTAI_BACKUP_ROOT="$T/backups" MOTAI_ROLLBACK_SCRIPT="$W/rollback-stub.sh" \
    MOTAI_SMOKE_DEADLINE_SECONDS=1 MOTAI_SMOKE_RETRY_SLEEP=0 ${envs[@]+"${envs[@]}"} "$@" > "$T/out.log" 2>&1
  RC=$?; OUT=$(cat "$T/out.log")
}
has() { [[ $OUT == *"$1"* ]]; }
lacks() { [[ $OUT != *"$1"* ]]; }
nolog() { [ ! -e "$T/$1" ]; }
cnt() { grep -c -- "$2" "$T/$1" 2>/dev/null; }
cntis() { [ "$(cnt "$1" "$2")" = "$3" ]; }
no_token_leak() { ! grep -rqF -- "$TOKEN" "$T"; }
docut() { run "$@" -- bash "$CUT" cutover --token-file "$W/token"; }
backups_empty() { [ -z "$(ls -A "$T/backups")" ]; }
REAL_RB=$HERE/motai-rollback.sh
real_cut() { docut MOTAI_ROLLBACK_SCRIPT="$REAL_RB" "$@"; }
event_line() { grep -n -m1 -- "$1" "$T/events.log" | cut -d: -f1; }
before() { local a b; a=$(event_line "$1"); b=$(event_line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
old_untouched() { # old console wallet files still hold their original content and no install wrote to them
  [ "$(cat "$T/oldstate/wallet-state.json")" = "OLD-wallet-state" ] && [ "$(cat "$T/oldstate/wallet-credentials.json")" = "OLD-wallet-credentials" ] &&
    ! grep -q "install-to $T/oldstate" "$T/events.log" 2>/dev/null
}
old_got_new() {
  [ "$(cat "$T/oldstate/wallet-state.json")" = "REFRESHED-state" ] && [ "$(cat "$T/oldstate/wallet-credentials.json")" = "REFRESHED-credentials" ]
}
has_old_backup() { grep -qx "OLD-wallet-state" "$(ls "$T"/backups/*/old-wallet-state.json.at-rollback-* | head -n 1)"; }
rollback_called() { grep -q "rollback called with: $T/backups/new-api-ops-cutover-" "$T/rollback.log"; }

echo "--- cutover: happy path"
new_case; docut
check "happy path exits 0" [ "$RC" = 0 ]
check "happy path: smoke passed message" has "smoke test passed on port 3001 (attempt 1)"
check "happy path: no rollback" nolog rollback.log
check "happy path: 4 smoke calls ok" cntis out.log "result=ok" 4
check "happy path: 2 count_tokens calls" cntis curl.log "/v1/messages/count_tokens" 2
check "happy path: 2 streaming calls with max_tokens 1" cntis curl.log '"max_tokens":1,"stream":true' 2
check "happy path: opus covered twice" cntis curl.log "claude-opus-5.5" 2
check "happy path: sonnet covered twice" cntis curl.log "claude-sonnet-5.5" 2
check "happy path: haiku is not a gate" cntis curl.log "claude-haiku-4-5" 0
check "happy path: fable is not a gate" cntis curl.log "claude-fable-5-1" 0
check "happy path: log has no response bodies" lacks "input_tokens"
check "happy path: port mapping changed" grep -q '"3001:3001"' "$T/new/compose.yaml"
check "happy path: token not in any log, argv or env dump" no_token_leak

echo "--- cutover: smoke failure triggers rollback"
new_case; docut MOTAI_T_SMOKE_FAIL=always
check "smoke failure exits 1" [ "$RC" = 1 ]
check "smoke failure: rollback script called with backup dir" rollback_called
check "smoke failure: rollback logged OK" has "AUTO-ROLLBACK OK"
check "smoke failure: failure reason logged" has "smoke test still failing on port 3001"
check "smoke failure: rolled back only once" cntis rollback.log "rollback called" 1
check "smoke failure: token not leaked" no_token_leak

echo "--- cutover: smoke recovers on retry"
new_case; docut MOTAI_T_SMOKE_FAIL_FIRST=4 MOTAI_SMOKE_DEADLINE_SECONDS=60
check "retry exits 0" [ "$RC" = 0 ]
check "retry: passed on attempt 2" has "(attempt 2)"
check "retry: no rollback" nolog rollback.log

echo "--- cutover: failures after the first production change roll back"
new_case; docut MOTAI_T_DOCKER_FAIL="stop -t 30"
check "phase 2 failure exits 1" [ "$RC" = 1 ]
check "phase 2 failure: rollback called" rollback_called
check "phase 2 failure: old New API not stopped" cntis docker.log "stop -t 60" 0
new_case; docut MOTAI_T_DOCKER_FAIL="pg_dump"
check "phase 3 failure exits 1" [ "$RC" = 1 ]
check "phase 3 failure: rollback called" rollback_called
new_case; docut MOTAI_T_DOCKER_FAIL="stop -t 60"
check "phase 5 failure exits 1" [ "$RC" = 1 ]
check "phase 5 failure: rollback called" rollback_called

echo "--- cutover: rollback itself fails"
new_case; docut MOTAI_T_SMOKE_FAIL=always MOTAI_T_ROLLBACK_RC=7
check "failed rollback exits 99" [ "$RC" = 99 ]
check "failed rollback is logged loudly" has "AUTO-ROLLBACK FAILED (rollback exit 7)"
check "failed rollback prints manual command" has "run by hand"

echo "--- cutover: read-only phases never roll back"
new_case; docut MOTAI_T_DOCKER_FAIL="inspect"
check "preflight failure exits non-zero" [ "$RC" != 0 ]
check "preflight failure: no rollback" nolog rollback.log
check "preflight failure: says nothing to roll back" has "nothing to roll back"
check "preflight failure: no container stopped" cntis docker.log "stop" 0
check "preflight failure: no backup dir created" backups_empty
new_case; docut MOTAI_T_DOCKER_FAIL="up -d console"
check "phase 1 failure exits non-zero" [ "$RC" != 0 ]
check "phase 1 failure: no rollback" nolog rollback.log
check "phase 1 failure: no container stopped" cntis docker.log "stop" 0

echo "--- token file checks"
cp "$W/token" "$W/badmeta-token"
new_case; run -- bash "$CUT" cutover --token-file "$W/badmeta-token"
check "wrong owner/mode exits 3" [ "$RC" = 3 ]
check "wrong owner/mode: explains 0600" has "0600"
check "wrong owner/mode: nothing touched" nolog docker.log
check "wrong owner/mode: no curl" nolog curl.log
check "wrong owner/mode: no backup dir" backups_empty
new_case; run -- bash "$CUT" cutover --token-file "$W/badtoken"
check "bad token content exits 3" [ "$RC" = 3 ]
check "bad token content: nothing touched" nolog docker.log
new_case; run -- bash "$CUT" cutover --token-file "$W/does-not-exist"
check "missing token file exits 3" [ "$RC" = 3 ]
new_case; run -- bash "$CUT" --preflight 3101 --token-file "$W/badmeta-token"
check "smoke preflight also rejects bad token file" [ "$RC" = 3 ]

echo "--- --preflight <port> changes nothing"
new_case
before=$(cksum "$T/new/.env" "$T/new/compose.yaml")
run -- bash "$CUT" --preflight 3101 --token-file "$W/token"
check "preflight passes" [ "$RC" = 0 ]
check "preflight prints PASS" has "preflight smoke PASS"
check "preflight: no docker call" nolog docker.log
check "preflight: no rollback" nolog rollback.log
check "preflight: no backup dir" backups_empty
check "preflight: files unchanged" [ "$before" = "$(cksum "$T/new/.env" "$T/new/compose.yaml")" ]
check "preflight: exactly 4 curl calls" [ "$(wc -l < "$T/curl.log")" = 4 ]
check "preflight: all calls to the given port" cntis curl.log "127.0.0.1:3101/" 4
check "preflight: token not leaked" no_token_leak
new_case
run MOTAI_T_SMOKE_FAIL=always -- bash "$CUT" --preflight 3101 --token-file "$W/token"
check "failing preflight exits 1" [ "$RC" = 1 ]
check "failing preflight prints FAIL" has "preflight smoke FAIL"
check "failing preflight: no docker call, no rollback" bash -c "[ ! -e '$T/docker.log' ] && [ ! -e '$T/rollback.log' ]"

has_marker() { ls "$T"/backups/*/wallet-handed-over >/dev/null 2>&1; }
INST_OLD() { echo "install-to $T/oldstate"; }

echo "--- real rollback script: wallet before the handoff (phase 2/3) is left alone"
new_case; real_cut MOTAI_T_DOCKER_FAIL="stop -t 30"
check "phase 2 failure exits 1" [ "$RC" = 1 ]
check "phase 2 failure: auto rollback ran OK" has "AUTO-ROLLBACK OK"
check "phase 2 failure: no handover marker" bash -c '! ls "$1"/backups/*/wallet-handed-over' _ "$T"
check "phase 2 failure: old wallet untouched" old_untouched
check "phase 2 failure: rollback says wallet left untouched" has "left untouched"
check "phase 2 failure: new console not stopped by rollback" cntis docker.log "stop console" 0
check "phase 2 failure: old containers restarted" cntis docker.log "^start new-api-ops-shadow" 1
new_case; real_cut MOTAI_T_DOCKER_FAIL="pg_dump"
check "phase 3 failure exits 1" [ "$RC" = 1 ]
check "phase 3 failure: auto rollback ran OK" has "AUTO-ROLLBACK OK"
check "phase 3 failure: old wallet untouched" old_untouched
check "phase 3 failure: new console not stopped by rollback" cntis docker.log "stop console" 0

echo "--- real rollback script: wallet after the handoff goes back, after the new console stopped"
wallet_back() { # wallet_back <label>: shared assertions for failures after phase 4
  check "$1: exits 1" [ "$RC" = 1 ]
  check "$1: handover marker written" has_marker
  check "$1: auto rollback ran OK" has "AUTO-ROLLBACK OK"
  check "$1: old console got the new console's refreshed wallet" old_got_new
  check "$1: old wallet saved as old-*.at-rollback-*" has_old_backup
  check "$1: new console stopped before the wallet copy" before "stop console" "$(INST_OLD)"
  check "$1: wallet copied before the old console started" before "$(INST_OLD)" "docker start new-api-ops-shadow"
  check "$1: token not leaked" no_token_leak
}
new_case; real_cut MOTAI_T_DOCKER_FAIL="stop -t 60" MOTAI_T_REFRESH_ON="stop -t 60"
wallet_back "phase 5 failure"
new_case; real_cut MOTAI_T_DOCKER_FAIL_ONCE="up -d core console" MOTAI_T_REFRESH_ON="up -d core console"
wallet_back "phase 6 failure"
new_case; real_cut MOTAI_T_SMOKE_FAIL=always MOTAI_T_REFRESH_ON="up -d core console"
wallet_back "smoke failure"

echo "--- real rollback script: new console cannot be stopped"
new_case; real_cut MOTAI_T_SMOKE_FAIL=always MOTAI_T_REFRESH_ON="up -d core console" MOTAI_T_CONSOLE_STUCK=1
check "stuck console: cutover exits 99" [ "$RC" = 99 ]
check "stuck console: rollback failure logged" has "AUTO-ROLLBACK FAILED"
check "stuck console: explains two writers" has "refusing to copy the wallet"
check "stuck console: wallet not copied" old_untouched
check "stuck console: old containers not started" cntis docker.log "^start new-api-ops-shadow" 0

echo "--- rollback warnings (exit 10)"
direct_backup() { # direct_backup <marker 1|0>: hand-made backup dir for running motai-rollback.sh by itself
  BK=$T/bk; mkdir -p "$BK"
  cp "$T/new/compose.yaml" "$BK/trial-compose.before-cutover.yaml"
  [ "$1" = 1 ] && date +%FT%T > "$BK/wallet-handed-over"
  echo NEWCRED > "$T/new/console/state/wallet-credentials.json"
  echo NEWSTATE > "$T/new/console/state/wallet-state.json"
}
new_case; direct_backup 1; rm "$T/new/console/state/wallet-state.json"
run -- bash "$REAL_RB" "$BK"
check "missing new wallet file: exit 10, not 99" [ "$RC" = 10 ]
check "missing new wallet file: warning names the file" has "WARNING: new console wallet-state.json is missing"
check "missing new wallet file: the other file is still copied" [ "$(cat "$T/oldstate/wallet-credentials.json")" = NEWCRED ]
check "missing new wallet file: old file kept as is" [ "$(cat "$T/oldstate/wallet-state.json")" = OLD-wallet-state ]
check "missing new wallet file: old console still started" cntis docker.log "^start new-api-ops-shadow" 1
new_case; direct_backup 1
run -- bash "$REAL_RB" "$BK"
check "complete direct rollback exits 0" [ "$RC" = 0 ]
check "complete direct rollback copies both files" bash -c '[ "$(cat "$1/oldstate/wallet-state.json")" = NEWSTATE ] && [ "$(cat "$1/oldstate/wallet-credentials.json")" = NEWCRED ]' _ "$T"
new_case; direct_backup 0
run -- bash "$REAL_RB" "$BK"
check "no marker: direct rollback exits 0" [ "$RC" = 0 ]
check "no marker: old wallet untouched, new console not stopped" bash -c '[ "$(cat "$1/oldstate/wallet-state.json")" = OLD-wallet-state ] && ! grep -q "stop console" "$1/docker.log"' _ "$T"
new_case; direct_backup 1
run MOTAI_OLD_STATE_DIR="$T/nope" -- bash "$REAL_RB" "$BK"
check "marker but no old state dir: unsafe, rollback aborts" [ "$RC" = 1 ]
check "marker but no old state dir: nothing was stopped or started" nolog docker.log
new_case; direct_backup 1; rm "$BK/trial-compose.before-cutover.yaml"
run -- bash "$REAL_RB" "$BK"
check "missing pre-cutover compose: rollback aborts" [ "$RC" = 1 ]
new_case; real_cut MOTAI_T_SMOKE_FAIL=always MOTAI_T_ROLLBACK_RC=10 MOTAI_ROLLBACK_SCRIPT="$W/rollback-stub.sh"
check "cutover treats rollback exit 10 as done with warnings" has "AUTO-ROLLBACK OK WITH WARNINGS"
check "cutover still exits with the original failure code" [ "$RC" = 1 ]

echo "--- usage errors"
new_case
run -- bash "$CUT";                                         check "no args exits 2" [ "$RC" = 2 ]
run -- bash "$CUT" cutover;                                 check "cutover without token file exits 2" [ "$RC" = 2 ]
run -- bash "$CUT" --preflight 3101;                        check "--preflight without token file exits 2" [ "$RC" = 2 ]
run -- bash "$CUT" --preflight abc --token-file "$W/token"; check "--preflight bad port exits 2" [ "$RC" = 2 ]
run -- bash "$CUT" preflight cutover;                       check "two modes exit 2" [ "$RC" = 2 ]
check "usage errors touched nothing" nolog docker.log

echo "--- detached launcher"
mkdir -p "$W/fake" "$W/dlogs"
cat > "$W/fake/motai-cutover.sh" <<'EOF'
#!/usr/bin/env bash
case $1 in
  check-token) [ "${FAKE_TOKEN_OK:-1}" = 1 ] || { echo "bad token" >&2; exit 3; } ;;
  cutover)
    echo "fake cutover started $*"
    trap 'kill $c 2>/dev/null; exit 0' TERM
    "$REAL_SLEEP" 30 & c=$!
    wait ;;
esac
EOF
PIDF=$W/run.pid
launch() { # launch [env assignments...]; sets RCD OUTD
  OUTD=$(env PATH="$W/bin:$REAL_PATH" MOTAI_CUTOVER_SCRIPT="$W/fake/motai-cutover.sh" MOTAI_PID_FILE="$PIDF" \
    MOTAI_LOG_DIR="$W/dlogs" "$@" timeout 60 bash "$DET" "$W/token" 2>&1)
  RCD=$?
}
alive() { kill -0 "$1" 2>/dev/null; }
stop_pid() { local p=$1 i; kill "$p" 2>/dev/null; for i in $(seq 1 50); do alive "$p" || return 0; "$REAL_SLEEP" 0.1; done; return 1; }
dhas() { [[ $OUTD == *"$1"* ]]; }

launch
P1=$(cat "$PIDF" 2>/dev/null); BGPIDS+=("$P1")
check "first launch exits 0" [ "$RCD" = 0 ]
check "launch prints log path" dhas "log: $W/dlogs/motai-cutover-"
check "launch prints pid matching pid file" dhas "pid: $P1"
check "pid file holds a numeric pid" bash -c '[[ $1 =~ ^[0-9]+$ ]]' _ "$P1"
check "cutover process is alive after the launcher returned" alive "$P1"
for _ in $(seq 1 50); do grep -qs "fake cutover started cutover --token-file" "$W"/dlogs/*.log && break; "$REAL_SLEEP" 0.1; done
check "cutover output goes to the log file" grep -qs "fake cutover started cutover --token-file $W/token" "$W"/dlogs/*.log
check "token value is not on the launch line or in the log" bash -c "! grep -rqF -- '$TOKEN' '$W/dlogs' && [[ '$OUTD' != *'$TOKEN'* ]]"

launch
check "second launch while running is refused" [ "$RCD" = 1 ]
check "refusal says already running" dhas "already running"
check "refusal keeps the original pid" [ "$(cat "$PIDF")" = "$P1" ]
check "refusal starts no second log" [ "$(ls "$W/dlogs" | wc -l)" = 1 ]

stop_pid "$P1"
launch
P2=$(cat "$PIDF" 2>/dev/null); BGPIDS+=("$P2")
check "stale pid file does not block a new launch" [ "$RCD" = 0 ]
check "new launch has a new live pid" bash -c "[ '$P2' != '$P1' ] && kill -0 '$P2'"

stop_pid "$P2"
"$REAL_SLEEP" 30 & UNRELATED=$!; BGPIDS+=("$UNRELATED"); echo "$UNRELATED" > "$PIDF"
launch
P3=$(cat "$PIDF" 2>/dev/null); BGPIDS+=("$P3")
check "pid reused by an unrelated process does not block a launch" [ "$RCD" = 0 ]
check "launch after pid reuse replaces the pid" [ "$P3" != "$UNRELATED" ]
kill "$UNRELATED" 2>/dev/null

stop_pid "$P3"
logs_before=$(ls "$W/dlogs" | wc -l)
launch FAKE_TOKEN_OK=0
check "bad token file makes the launcher fail" [ "$RCD" != 0 ]
check "bad token file: no cutover started, no new log" [ "$(ls "$W/dlogs" | wc -l)" = "$logs_before" ]

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = 0 ]
