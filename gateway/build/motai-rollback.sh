#!/usr/bin/env bash
# Roll back motai-cutover.sh: release 3001/8787, hand the wallet back, restart the old New API stack.
# Usage on the lab host as root: motai-rollback.sh /var/backups/services/new-api-ops-cutover-<stamp>
# New requests return to the old New API; requests already finished on the gateway are not replayed.
# Wallet refresh tokens have one writer at a time, so the wallet is handled by the "wallet-handed-over" marker that
# motai-cutover.sh writes into the backup dir right after phase 4:
#   no marker: the old console's own wallet files are the newest; they are not touched.
#   marker:    the new console is stopped first (rollback aborts if it cannot be confirmed stopped), then its
#              wallet-*.json are copied back to the old console (old files are saved to $BACKUP/old-*.at-rollback-*).
# Exit codes: 0 done, 10 done with warnings (something optional was missing and skipped, see WARNING lines), other = failed.
set -euo pipefail
umask 077
BACKUP=${1:?backup directory from motai-cutover.sh}
# MOTAI_* overrides exist so the stubbed tests can run off the lab host; the defaults are the production paths.
NEW=${MOTAI_NEW_DIR:-/opt/apps/motai-trial-20261028}
OLD_STATE=${MOTAI_OLD_STATE_DIR:-/opt/apps/new-api-ops/state/console}
OLD_PROJECT=new-api-ops-shadow
WARN_RC=10
WARNINGS=0
warn() { WARNINGS=$((WARNINGS + 1)); echo "WARNING: $*"; }
die() { echo "rollback aborted: $*" >&2; exit 1; }
[ -f "$BACKUP/trial-compose.before-cutover.yaml" ] || die "$BACKUP/trial-compose.before-cutover.yaml is missing, cannot restore the trial compose"
[ -d "$NEW" ] || die "trial directory $NEW is missing"
cd "$NEW"
stamp=$(date +%Y%m%dT%H%M%S)
HANDED=0
if [ -f "$BACKUP/wallet-handed-over" ]; then
  HANDED=1
  [ -d "$OLD_STATE" ] || die "wallet was handed over but the old console state dir $OLD_STATE is missing"
fi

echo "=== stop new console automation and release 3001/8787"
if [ "$HANDED" = 1 ]; then
  echo "=== wallet was handed over at $(cat "$BACKUP/wallet-handed-over"): stop the new console first (single wallet writer)"
  docker compose --env-file .env stop console 2>&1 | tail -n 2 || die "could not stop the new console; wallet not copied, old console not started"
  cid=$(docker compose --env-file .env ps -q console) || die "could not query the new console state; wallet not copied, old console not started"
  if [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Running}}' "$cid")" = true ]; then
    die "new console is still running; refusing to copy the wallet (two writers); old console not started"
  fi
  echo "=== new console stopped; hand its wallet state back to the old console"
  for f in wallet-credentials.json wallet-state.json; do
    if [ ! -f "console/state/$f" ]; then
      warn "new console $f is missing: not copied back, the old console keeps its own $f"
      continue
    fi
    if [ -f "$OLD_STATE/$f" ]; then
      cp "$OLD_STATE/$f" "$BACKUP/old-$f.at-rollback-$stamp"
    else
      warn "old console $f is missing: nothing to back up before the copy"
    fi
    install -m 600 -o "$(stat -c %u "$OLD_STATE")" -g "$(stat -c %g "$OLD_STATE")" "console/state/$f" "$OLD_STATE/$f"
  done
else
  echo "=== wallet was not handed over (no wallet-handed-over marker): the old console's wallet files are left untouched"
fi

if [ -f compose.yaml ]; then
  cp compose.yaml "$BACKUP/trial-compose.at-rollback-$stamp.yaml"
else
  warn "trial compose.yaml is missing: no at-rollback copy saved"
fi
cp "$BACKUP/trial-compose.before-cutover.yaml" compose.yaml
docker compose --env-file .env up -d core console 2>&1 | tail -n 2

echo "=== start old New API and console"
docker start "$OLD_PROJECT-new-api-1" "$OLD_PROJECT-console-1"
for i in $(seq 1 60); do curl -sf --max-time 5 http://127.0.0.1:8787/api/healthz >/dev/null && break; sleep 1; done
ss -ltnp | grep -E ':(3001|8787|3101|8788) '
curl -sS --max-time 10 http://127.0.0.1:8787/api/healthz | cut -c1-200; echo
echo "rollback done; gateway trial stays on 3101/8788 with automation disabled"
if [ "$WARNINGS" -gt 0 ]; then
  echo "rollback finished with $WARNINGS warning(s), see the WARNING lines above"
  exit "$WARN_RC"
fi
