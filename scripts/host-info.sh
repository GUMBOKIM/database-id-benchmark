#!/usr/bin/env bash
# Prints the machine and Docker engine a run used, as JSON (bench.sh saves it as
# results/<RUN_ID>/host.json and the report shows it).
#
#   scripts/host-info.sh              # now
#   scripts/host-info.sh --after-run  # recorded after the run, for an older result
set -euo pipefail

esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
lscpu_get() { LC_ALL=C lscpu | awk -F: -v k="$1" '$1 == k { sub(/^[ \t]+/, "", $2); print $2; exit }'; }
cat_or() { cat "$1" 2>/dev/null || echo "$2"; }

docker_dev=$(findmnt -no SOURCE -T /var/lib/docker 2>/dev/null || true)
disk=$( [[ -n $docker_dev ]] && lsblk -no PKNAME "$docker_dev" 2>/dev/null | head -1 || true)
disk_model=$( [[ -n $disk ]] && lsblk -dno MODEL "/dev/$disk" 2>/dev/null | sed 's/ *$//' || true)
engine=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || echo unknown)
. /etc/os-release

cat <<EOF
{
  "recordedAt": $(esc "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),
  "recordedAfterRun": $([[ ${1:-} == --after-run ]] && echo true || echo false),
  "cpu": $(esc "$(lscpu_get 'Model name')"),
  "cores": $(( $(lscpu_get 'Core(s) per socket') * $(lscpu_get 'Socket(s)') )),
  "threads": $(nproc --all),
  "l3": $(esc "$(lscpu_get 'L3 cache')"),
  "maxMHz": $(esc "$(lscpu_get 'CPU max MHz')"),
  "governor": $(esc "$(cat_or /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor n/a)"),
  "boost": $(esc "$(cat_or /sys/devices/system/cpu/cpufreq/boost n/a)"),
  "memoryBytes": $(LC_ALL=C free -b | awk '/^Mem:/ { print $2 }'),
  "os": $(esc "$PRETTY_NAME"),
  "kernel": $(esc "$(uname -r)"),
  "dockerDisk": $(esc "${disk:-unknown}"),
  "dockerDiskModel": $(esc "${disk_model:-unknown}"),
  "docker": {
    "context": $(esc "$(docker context show 2>/dev/null || echo unknown)"),
    "engine": $(esc "$engine"),
    "desktopVm": $([[ $engine == "Docker Desktop" ]] && echo true || echo false),
    "version": $(esc "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"),
    "cpus": $(docker info --format '{{.NCPU}}' 2>/dev/null || echo null),
    "memoryBytes": $(docker info --format '{{.MemTotal}}' 2>/dev/null || echo null),
    "cgroupDriver": $(esc "$(docker info --format '{{.CgroupDriver}}' 2>/dev/null || echo unknown)")
  },
  "dbCpus": $(esc "${DB_CPUS:-0-7,16-23}"),
  "runnerCpus": $(esc "${RUNNER_CPUS:-8-15,24-31}")
}
EOF
