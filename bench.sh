#!/usr/bin/env bash
# Full benchmark: generate IDs once, then run each database ALONE, one after another.
# Only Docker is needed on the host.
#
#   ./bench.sh                         # every database, default settings (see README)
#   DBS="postgres mysql" ./bench.sh    # some databases
#   SIZES=10,100,1000 ./bench.sh       # quick smoke test
#
# Results: results/<RUN_ID>/<db>.json and results/<RUN_ID>/REPORT.md
set -euo pipefail
cd "$(dirname "$0")"

export RUN_ID=${RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}
DBS=${DBS:-"postgres mysql mariadb oracle mssql sqlite sqlite_norowid"}

run() { docker compose --profile runner run --rm -T runner "$@"; }
log() { echo "$(date +%H:%M:%S) $*"; }

log "run $RUN_ID: $DBS"
run npm ci --no-audit --no-fund --loglevel=error
run node src/gen.js

for db in $DBS; do
  case $db in
    sqlite*) service="" ;; # in-process, runs inside the runner container
    *) service=$db ;;
  esac
  if [[ -n $service ]]; then
    log "starting $service"
    docker compose --profile db rm -fsv "$service" >/dev/null 2>&1 || true
    docker compose --profile db up -d --wait "$service"
  fi
  run node src/bench.js "$db" || log "!! $db failed, continuing"
  if [[ -n $service ]]; then
    docker compose --profile db rm -fsv "$service" >/dev/null
  fi
done

run node src/report.js "results/$RUN_ID"
log "done: results/$RUN_ID/REPORT.md"
