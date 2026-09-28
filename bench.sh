#!/usr/bin/env bash
# Full benchmark: generate IDs once, then run each database ALONE, one after another,
# with a fresh container for every repetition. Only Docker is needed on the host.
#
#   ./bench.sh                              # defaults (see README)
#   N_MAX=10000 ./bench.sh                  # quick smoke test
#   DBS="postgres mysql" ./bench.sh         # more databases
#   RUN_ID=<earlier run> REPS="2 3" TYPES=autoinc,uuidv4 ./bench.sh
#                                           # add repetitions to an earlier run
#
# Results: results/<RUN_ID>/<db>.r<rep>.json, REPORT.md, summary.csv, report.html
set -euo pipefail
cd "$(dirname "$0")"

export RUN_ID=${RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}
DBS=${DBS:-"postgres"}
REPS=${REPS:-"1"}

run() { docker compose --profile runner run --rm -T runner "$@"; }
log() { echo "$(date +%H:%M:%S) $*"; }

log "run $RUN_ID: $DBS, reps $REPS"
mkdir -p "results/$RUN_ID"
scripts/host-info.sh > "results/$RUN_ID/host.json"
# Docker Desktop resets the current context to its VM when it starts; CPU pinning and
# cold-cache runs then act on the VM, not this machine. Say so loudly.
if [[ $(docker info --format '{{.OperatingSystem}}') == "Docker Desktop" ]]; then
  log "!! running on Docker Desktop (a VM). For the native engine: docker context use default"
fi
run npm ci --no-audit --no-fund --loglevel=error
run node src/gen.js

for rep in $REPS; do
  for db in $DBS; do
    log "starting $db (rep $rep)"
    docker compose --profile db rm -fsv "$db" >/dev/null 2>&1 || true
    docker compose --profile db up -d --wait "$db"
    REP=$rep run node src/bench.js "$db" || log "!! $db rep $rep failed, continuing"
    docker compose --profile db rm -fsv "$db" >/dev/null
  done
done

run node src/report.js "results/$RUN_ID"
# The native engine runs the container as root; hand the files back to the host user.
run chown -R "$(id -u):$(id -g)" "results/$RUN_ID" cache
log "done: results/$RUN_ID/report.html"
