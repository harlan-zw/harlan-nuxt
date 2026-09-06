#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/history/daily" "$test_root/history/jobs" \
  "$test_root/state/jobs" "$test_root/state/queued" "$test_root/state/spend" \
  "$test_root/state/spend-memory" "$test_root/state/held"

cat >"$test_root/state/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|0|4|4|4g|8g|10g
EOF
printf '2\n' >"$test_root/state/queued/example-ci"
# A held pool reads as an idle one until the reason reaches the snapshot. The
# mtime is the hold's start, so a dashboard can age it.
printf 'Available memory 17g, headroom 6g, RAM-backed filesystems hold 12g\n' >"$test_root/state/held/example-ci"
touch --date='@1787930450' "$test_root/state/held/example-ci"
printf '4\n' >"$test_root/state/spend/harlan-desktop-example-ci-burst-1"
printf '4\n' >"$test_root/state/spend-memory/harlan-desktop-example-ci-burst-1"
cat >"$test_root/state/jobs/harlan-desktop-example-ci-burst-1.json" <<'EOF'
{"name":"test & build","startedAt":1787930400000}
EOF
cat >"$test_root/history/jobs/2026-08-28.ndjson" <<'EOF'
{"completedAt":1787930300000,"name":"lint","outcome":"Succeeded","pool":"example-ci","repository":"harlan-zw/example","startedAt":1787930200000}
EOF
cat >"$test_root/history/daily/2026-08-28.json" <<'EOF'
{"actualMilliseconds":100000,"billableMinutes":2,"completed":1,"date":"2026-08-28","trackedSince":1787930200000}
EOF

cat >"$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  ps)
    [[ "${TEST_DOCKER_FAIL:-}" == ps ]] && exit 1
    printf '%s\n' '{"ID":"abc123","Labels":"com.harlanzw.desktop-runner.pool=example-ci,com.harlanzw.desktop-runner.repository=harlan-zw/example,com.harlanzw.desktop-runner=true","Names":"harlan-desktop-example-ci-burst-1"}'
    ;;
  stats)
    printf '%s\n' '{"CPUPerc":"83.40%","ID":"abc123","MemUsage":"620MiB / 8GiB","Name":"harlan-desktop-example-ci-burst-1","NetIO":"879MB / 7.64MB","PIDs":"47"}'
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod +x "$test_root/bin/docker"

cat >"$test_root/bin/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  +%s) printf '1787930500\n' ;;
  +%s.%N) printf '1787930500.123456789\n' ;;
  +%s%3N) printf '1787930500123456789\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$test_root/bin/date"

PATH="$test_root/bin:$PATH" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=20 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=24 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH_MS=1787930500000 \
./infra/github-runner/publish-status "$test_root/state" "$test_root/state/status.json" "$test_root/history"

snapshot="$test_root/state/status.json"
jq --exit-status '
  .version == 4
  and .updatedAt == 1787930500000
  and .budgets == { cpu: 20, memoryBytes: 25769803776, memoryHeadroomBytes: 8589934592 }
  and .jobTotals == { actualMilliseconds: 100000, billableMinutes: 2, completed: 1, trackedSince: 1787930200000 }
  and .pools == [{
    cpuPerRunner: 4,
    heldReason: "Available memory 17g, headroom 6g, RAM-backed filesystems hold 12g",
    heldSince: 1787930450000,
    live: 1,
    maximum: 4,
    memoryLimitBytes: 8589934592,
    memoryReservationBytes: 4294967296,
    name: "example-ci",
    queued: 2,
    repository: "harlan-zw/example",
    running: 1
  }]
  and .runners == [{
    activity: "Running",
    cpuPercent: 83.4,
    job: { name: "test & build", startedAt: 1787930400000 },
    memoryBytes: 650117120,
    name: "harlan-desktop-example-ci-burst-1",
    networkRxBytes: 879000000,
    networkTxBytes: 7640000,
    pool: "example-ci",
    repository: "harlan-zw/example",
    tasks: 47
  }]
  and (.recentJobs | length) == 1
  and (.hostMemory.totalBytes > 0)
  and (.hostMemory.availableBytes > 0)
  and (.hostMemory.ramBackedBytes >= 0)
  and (.hostMemory.inFlightBytes == 4294967296)
' "$snapshot" >/dev/null

if [[ "$(stat -c '%a' "$snapshot")" != 640 ]]; then
  printf 'Expected the runner snapshot to be group-readable only.\n' >&2
  exit 1
fi

PATH="$test_root/bin:$PATH" \
./infra/github-runner/publish-status "$test_root/state" "$test_root/state/status.json" "$test_root/history"
if ! jq --exit-status '.updatedAt == 1787930500000' "$snapshot" >/dev/null; then
  printf 'Expected a portable millisecond timestamp.\n' >&2
  exit 1
fi

snapshot_checksum="$(sha256sum "$snapshot")"
set +e
TEST_DOCKER_FAIL=ps \
PATH="$test_root/bin:$PATH" \
./infra/github-runner/publish-status "$test_root/state" "$test_root/state/status.json" "$test_root/history" >/dev/null 2>&1
failure_status=$?
set -e
if (( failure_status == 0 )) || [[ "$(sha256sum "$snapshot")" != "$snapshot_checksum" ]]; then
  printf 'Expected Docker failure to preserve the previous runner snapshot.\n' >&2
  exit 1
fi

printf 'Runner status snapshot passed.\n'
