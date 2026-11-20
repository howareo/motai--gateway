#!/usr/bin/env bash
# Start motai-cutover.sh cutover in the background so an ssh drop or a dying caller cannot kill it half way.
# Usage on the lab host as root: motai-cutover-detached.sh <token-file>
#   token-file: root-owned, mode 0600, holds the real caller token used by the post-cutover smoke test.
# Log: /var/log/motai-cutover-<timestamp>.log   pid: /run/motai-cutover.pid
# Returns right after the launch and prints the log path and pid. Refuses to start while a previous cutover is still alive.
set -euo pipefail
umask 077
TOKEN_FILE=${1:?usage: motai-cutover-detached.sh <token-file>}
HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
CUTOVER=${MOTAI_CUTOVER_SCRIPT:-$HERE/motai-cutover.sh}
PID_FILE=${MOTAI_PID_FILE:-/run/motai-cutover.pid}
LOG_DIR=${MOTAI_LOG_DIR:-/var/log}

if [ -s "$PID_FILE" ]; then
  old=$(head -n 1 "$PID_FILE")
  if [[ $old =~ ^[0-9]+$ ]] && kill -0 "$old" 2>/dev/null; then
    # Guard against a stale pid file whose number was reused by an unrelated process.
    cmd=$(tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true)
    if [ -z "$cmd" ] || [[ $cmd == *motai-cutover* ]]; then
      echo "a cutover is already running (pid $old, pid file $PID_FILE); refusing to start another" >&2
      exit 1
    fi
  fi
  rm -f "$PID_FILE"
fi

# Reject a bad token file here so the operator sees it now, not only in the log of a detached run.
bash "$CUTOVER" check-token --token-file "$TOKEN_FILE"

LOG=$LOG_DIR/motai-cutover-$(date +%Y%m%dT%H%M%S).log
# The inner shell records its own pid, then becomes the cutover script, so the pid file always names the real process.
setsid nohup bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$PID_FILE" bash "$CUTOVER" cutover --token-file "$TOKEN_FILE" </dev/null >"$LOG" 2>&1 &
disown
for _ in $(seq 1 50); do [ -s "$PID_FILE" ] && break; sleep 0.1; done
[ -s "$PID_FILE" ] || { echo "cutover did not start; see $LOG" >&2; exit 1; }
echo "cutover started in background"
echo "log: $LOG"
echo "pid: $(cat "$PID_FILE")"
echo "follow: tail -f $LOG"
