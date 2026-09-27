#!/usr/bin/env bash
# Steadies the host for a benchmark run. Needs root.
#
#   sudo scripts/host-prep.sh on    # fixed clocks, empty page cache
#   sudo scripts/host-prep.sh off   # back to the defaults (powersave, boost on)
#
# Clocks: the performance governor with boost off keeps the CPU at one frequency, so
# temperature does not change speed halfway through a run.
# Page cache: Docker Desktop keeps its VM disk in a file on the host; dropping the
# host page cache means nothing left over from an earlier run is served from memory.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

governor() { for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo "$1" >"$f"; done; }
boost() { [[ -w /sys/devices/system/cpu/cpufreq/boost ]] && echo "$1" >/sys/devices/system/cpu/cpufreq/boost || echo "boost control not available"; }

case ${1:-} in
  on)
    governor performance
    boost 0
    sync
    echo 3 >/proc/sys/vm/drop_caches
    ;;
  off)
    governor powersave
    boost 1
    ;;
  *) echo "usage: $0 on|off" >&2; exit 1 ;;
esac

echo "governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor), boost: $(cat /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || echo n/a)"
