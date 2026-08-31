#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/runtime" "$test_root/calls" "$test_root/credentials"
printf 'repository-token\n' >"$test_root/credentials/github-harlan-zw-token"

cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|1|2|1|1g|2g|3g
EOF

cat >"$test_root/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${GH_TOKEN:-}" != repository-token ]]; then
  printf 'Expected the repository credential.\n' >&2
  exit 1
fi
printf '%s\n' "$*" >>"$TEST_CALLS/gh"
if [[ "$*" == *registration-token* ]]; then
  printf 'test-token\n'
fi
if [[ "$*" == *'actions/runs?status=in_progress'* && -f "$TEST_CALLS/queue-in-progress" ]]; then
  printf '78\t2026-08-27T04:30:00Z\n'
fi
if [[ "$*" == *'actions/runs?status=in_progress'* && -f "$TEST_CALLS/queue-empty-in-progress" ]]; then
  printf '79\t2026-08-27T04:30:00Z\n'
fi
if [[ "$*" == *'actions/runs/78/jobs'* && -f "$TEST_CALLS/queue-in-progress" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-enabled" ]]; then
  printf '77\t2026-08-27T04:30:00Z\n'
fi
if [[ "$*" == *'actions/runs/77/jobs'* && -f "$TEST_CALLS/queue-enabled" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n%.0s' 1 2
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-stale" ]]; then
  printf '76\t2026-08-26T00:00:00Z\n'
fi
if [[ "$*" == *'actions/runs/76/jobs'* && -f "$TEST_CALLS/queue-stale" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
EOF

cat >"$test_root/bin/free" <<'EOF'
#!/usr/bin/env bash
printf '              total used free shared buff/cache available\n'
if [[ -f "$TEST_CALLS/low-memory" ]]; then
  printf 'Mem:             32   24    2      0          6         2\n'
else
  printf 'Mem:             32    4   20      0          8        24\n'
fi
EOF

cat >"$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
shift || true
printf '%s %s\n' "$command_name" "$*" >>"$TEST_CALLS/docker"

case "$command_name" in
  image|volume|rm)
    exit 0
    ;;
  stop)
    container_id="${*: -1}"
    touch "$TEST_CALLS/stop-started-$container_id"
    for _ in $(seq 1 50); do
      started_count="$(find "$TEST_CALLS" -name 'stop-started-*' | wc -l)"
      if (( started_count == 4 )); then
        printf '%s\n' "$container_id" >>"$TEST_CALLS/stopped"
        exit 0
      fi
      sleep 0.02
    done
    printf 'Idle runner stops were serial.\n' >&2
    exit 1
    ;;
  ps)
    if [[ ! -e "$TEST_CALLS/leftovers-listed" ]]; then
      touch "$TEST_CALLS/leftovers-listed"
      printf 'leftover-%s\n' 1 2 3 4
    fi
    exit 0
    ;;
  container)
    exit 1
    ;;
  top)
    exit 1
    ;;
  run)
    if [[ " $* " == *' --entrypoint chown '* ]]; then
      exit 0
    fi

    name=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == --name ]]; then
        name="$argument"
        break
      fi
      previous="$argument"
    done

    if [[ "$name" == *-burst-* ]]; then
      printf '%s\n' "$name" >>"$TEST_CALLS/burst"
      sleep 5
      exit 0
    fi

    attempts_file="$TEST_CALLS/warm-attempts"
    attempts=0
    [[ -f "$attempts_file" ]] && read -r attempts <"$attempts_file"
    attempts=$(( attempts + 1 ))
    printf '%s\n' "$attempts" >"$attempts_file"
    if (( attempts == 1 )); then
      printf 'Running job: first\n'
      sleep 0.2
      printf 'Job first completed with result: Succeeded\n'
      exit 0
    fi

    sleep 5
    ;;
  *)
    exit 0
    ;;
esac
EOF

chmod +x "$test_root/bin/gh" "$test_root/bin/free" "$test_root/bin/docker"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_HISTORY_DIR="$test_root/history" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=1 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=1 \
HARLAN_DESKTOP_RUNNER_BURST_IDLE_SECONDS=30 \
HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS=0.05 \
HARLAN_DESKTOP_RUNNER_STATUS_OUTPUT="$test_root/calls/status.json" \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected SIGTERM to drain the supervisor and exit cleanly.\n' >&2
  exit 1
fi

if [[ ! -s "$test_root/calls/burst" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/docker"
  printf 'Expected released capacity to start the denied burst runner.\n' >&2
  exit 1
fi

if ! grep --quiet --fixed-strings -- '--memory-reservation 1g --memory 2g --memory-swap 3g' "$test_root/calls/docker"; then
  cat "$test_root/calls/docker"
  printf 'Expected the runner reservation and hard limit to stay separate.\n' >&2
  exit 1
fi

if (( $(wc -l <"$test_root/calls/stopped") != 4 )); then
  cat "$test_root/output"
  cat "$test_root/calls/docker"
  printf 'Expected four idle leftover runners to stop concurrently.\n' >&2
  exit 1
fi

if ! jq --exit-status '.recentJobs | any(.name == "first" and .outcome == "Succeeded")' "$test_root/calls/status.json" >/dev/null; then
  cat "$test_root/calls/status.json"
  printf 'Expected completed jobs in the published runner status.\n' >&2
  exit 1
fi

if ! jq --exit-status '.completed == 1' "$test_root/history/daily/"*.json >/dev/null; then
  printf 'Expected completed jobs to persist outside runtime state.\n' >&2
  exit 1
fi

printf 'Capacity retry passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-enabled"
cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|0|2|1|1g|2g|3g
EOF

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=2 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=2 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS=0.05 \
HARLAN_DESKTOP_RUNNER_STATUS_OUTPUT="$test_root/calls/status.json" \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected demand polling to drain cleanly.\n' >&2
  exit 1
fi

if (( $(wc -l <"$test_root/calls/burst") != 2 )); then
  cat "$test_root/output"
  cat "$test_root/calls/docker"
  printf 'Expected reservations to admit two queued runners.\n' >&2
  exit 1
fi

if ! jq --exit-status '.pools == [{ cpuPerRunner: 1, live: 0, maximum: 2, memoryLimitBytes: 2147483648, memoryReservationBytes: 1073741824, name: "example-ci", queued: 2, repository: "harlan-zw/example", running: 0 }]' "$test_root/calls/status.json" >/dev/null; then
  cat "$test_root/calls/status.json"
  printf 'Expected queued demand in the published runner status.\n' >&2
  exit 1
fi

queued_poll_count="$(grep -F -c 'actions/runs?status=queued' "$test_root/calls/gh")"
if (( queued_poll_count != 1 )); then
  cat "$test_root/calls/gh"
  printf 'Expected demand polling to preserve the GitHub API budget.\n' >&2
  exit 1
fi

printf 'Queued job demand passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-in-progress"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=1 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=1 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )) || [[ ! -s "$test_root/calls/burst" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/gh"
  printf 'Expected an in-progress workflow run with a queued job to start a runner.\n' >&2
  exit 1
fi

printf 'In-progress workflow demand passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-stale"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=1 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=1 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )) || [[ -s "$test_root/calls/burst" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/gh"
  printf 'Expected stale queued jobs to leave a zero-warm pool stopped.\n' >&2
  exit 1
fi

printf 'Stale queued job filtering passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-empty-in-progress"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=1 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=1 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )) || rg --quiet 'Queued job demand is unavailable' "$test_root/output"; then
  cat "$test_root/output"
  cat "$test_root/calls/gh"
  printf 'Expected an empty current run to report available demand.\n' >&2
  exit 1
fi

printf 'Empty current workflow demand passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-enabled" "$test_root/calls/low-memory"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=2 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=2 \
HARLAN_DESKTOP_RUNNER_MEMORY_HEADROOM_GIB=2 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )) || [[ -s "$test_root/calls/burst" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/docker"
  printf 'Expected host memory headroom to hold a queued runner.\n' >&2
  exit 1
fi

if ! grep --quiet 'Available memory 2g, headroom 2g; holding example-ci at 0' "$test_root/output"; then
  cat "$test_root/output"
  printf 'Expected the memory headroom decision in the supervisor log.\n' >&2
  exit 1
fi

printf 'Host memory headroom passed.\n'
