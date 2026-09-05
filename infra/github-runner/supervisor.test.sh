#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
state_home="$(mktemp -d)"
trap 'rm -rf "$test_root" "$state_home"' EXIT

# Every invocation must point HARLAN_DESKTOP_RUNNER_HISTORY_DIR at the test
# root. A write into the default history root lands here and fails the final
# check, so the suite can never touch real runner history again.
export XDG_STATE_HOME="$state_home"

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
  printf '78\t2026-08-27T04:30:00Z\tpull_request\tfix/live\t1111111111111111111111111111111111111111\n'
fi
if [[ "$*" == *'actions/runs?status=in_progress'* && -f "$TEST_CALLS/queue-empty-in-progress" ]]; then
  printf '79\t2026-08-27T04:30:00Z\tpull_request\tfix/live\t1111111111111111111111111111111111111111\n'
fi
if [[ "$*" == *'actions/runs/78/jobs'* && -f "$TEST_CALLS/queue-in-progress" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-enabled" ]]; then
  printf '77\t2026-08-27T04:30:00Z\tpull_request\tfix/live\t1111111111111111111111111111111111111111\n'
fi
if [[ "$*" == *'actions/runs/77/jobs'* && -f "$TEST_CALLS/queue-enabled" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n%.0s' 1 2
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-priority" ]]; then
  for _ in $(seq 1 50); do
    [[ -f "$TEST_CALLS/warm-running" ]] && break
    sleep 0.01
  done
  printf '73\t2026-08-27T04:30:00Z\tpush\tmain\t6666666666666666666666666666666666666666\n'
fi
if [[ "$*" == *'actions/runs/73/jobs'* && -f "$TEST_CALLS/queue-priority" ]]; then
  printf 'self-hosted,harlan-desktop-deploy\n'
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-cancel" ]]; then
  for _ in $(seq 1 50); do
    [[ -f "$TEST_CALLS/warm-running" ]] && break
    sleep 0.01
  done
  scans=0
  [[ -f "$TEST_CALLS/cancel-scans" ]] && read -r scans <"$TEST_CALLS/cancel-scans"
  scans=$(( scans + 1 ))
  printf '%s\n' "$scans" >"$TEST_CALLS/cancel-scans"
  if (( scans >= 2 )); then
    touch "$TEST_CALLS/scanned-after-cancel"
  fi
  printf '73\t2026-08-27T04:30:00Z\tpush\tmain\t6666666666666666666666666666666666666666\n'
fi
if [[ "$*" == *'actions/runs/73/jobs'* && -f "$TEST_CALLS/queue-cancel" ]]; then
  if [[ -f "$TEST_CALLS/scanned-after-cancel" ]]; then
    printf 'self-hosted,harlan-desktop-ci\n'
  else
    printf 'self-hosted,harlan-desktop-deploy\n'
    printf 'self-hosted,harlan-desktop-ci\n'
  fi
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-stale" ]]; then
  printf '76\t2026-08-26T00:00:00Z\tpull_request\tfix/closed\t3333333333333333333333333333333333333333\n'
fi
if [[ "$*" == *'actions/runs/76/jobs'* && -f "$TEST_CALLS/queue-stale" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-rot-push" ]]; then
  printf '75\t2026-08-26T00:00:00Z\tpush\tfix/gone\t4444444444444444444444444444444444444444\n'
fi
if [[ "$*" == *'actions/runs/75/jobs'* && -f "$TEST_CALLS/queue-rot-push" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-starved" ]]; then
  printf '75\t2026-08-26T00:00:00Z\tpull_request\tfix/open\t2222222222222222222222222222222222222222\n'
fi
if [[ "$*" == *'actions/runs/75/jobs'* && -f "$TEST_CALLS/queue-starved" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'pulls?state=open'* && -f "$TEST_CALLS/queue-starved" ]]; then
  printf 'fix/open\t2222222222222222222222222222222222222222\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-starved-collision" ]]; then
  printf '75\t2026-08-26T00:00:00Z\tpull_request\tfix/open\t2222222222222222222222222222222222222222\n'
fi
if [[ "$*" == *'actions/runs/75/jobs'* && -f "$TEST_CALLS/queue-starved-collision" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'pulls?state=open'* && -f "$TEST_CALLS/queue-starved-collision" ]]; then
  printf 'fix/open\t2222222222222222222222222222222222222222\n'
  printf 'fix/open\t5555555555555555555555555555555555555555\n'
fi
if [[ "$*" == *'actions/runs?status=queued'* && -f "$TEST_CALLS/queue-collision" ]]; then
  if [[ "$*" == *'.head_sha'* ]]; then
    printf '74\t2026-08-26T00:00:00Z\tpull_request\tfix/reused\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  else
    printf '74\t2026-08-26T00:00:00Z\tpull_request\tfix/reused\n'
  fi
fi
if [[ "$*" == *'actions/runs/74/jobs'* && -f "$TEST_CALLS/queue-collision" ]]; then
  printf 'self-hosted,harlan-desktop-ci\n'
fi
if [[ "$*" == *'pulls?state=open'* && -f "$TEST_CALLS/queue-collision" ]]; then
  if [[ "$*" == *'.head.sha'* ]]; then
    printf 'fix/reused\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
  else
    printf 'fix/reused\n'
  fi
fi
EOF

cat >"$test_root/bin/free" <<'EOF'
#!/usr/bin/env bash
if [[ -f "$TEST_CALLS/slow-free" ]]; then
  sleep 1
fi
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
      touch "$TEST_CALLS/warm-running"
      printf 'Running job: first\n'
      if [[ -f "$TEST_CALLS/hold-warm-job" ]]; then
        for _ in $(seq 1 2000); do
          [[ -f "$TEST_CALLS/scanned-after-cancel" ]] && break
          sleep 0.05
        done
      fi
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

if ! jq --exit-status '.pools == [{ cpuPerRunner: 1, heldReason: null, heldSince: null, live: 0, maximum: 2, memoryLimitBytes: 2147483648, memoryReservationBytes: 1073741824, name: "example-ci", queued: 2, repository: "harlan-zw/example", running: 0 }]' "$test_root/calls/status.json" >/dev/null; then
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
  printf 'Expected a closed pull request to leave a zero-warm pool stopped.\n' >&2
  exit 1
fi

printf 'Closed pull request demand filtering passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-rot-push"

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
  printf 'Expected an aged non-pull_request run to leave a zero-warm pool stopped.\n' >&2
  exit 1
fi

if grep --quiet 'pulls?state=open' "$test_root/calls/gh"; then
  cat "$test_root/calls/gh"
  printf 'Expected an aged non-pull_request run to skip pull request verification.\n' >&2
  exit 1
fi

printf 'Aged non-pull_request demand filtering passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-starved"

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
  printf 'Expected an aged run on an open pull request to still start a runner.\n' >&2
  exit 1
fi

printf 'Starved pull request demand passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-starved-collision"

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
  printf 'Expected an aged run whose commit another fork shared on the same branch to still start a runner.\n' >&2
  exit 1
fi

printf 'Shared branch head demand passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-collision"

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
  printf 'Expected an aged run from a closed pull request whose branch name an open pull request reused to leave a zero-warm pool stopped.\n' >&2
  exit 1
fi

if grep --quiet 'actions/runs/74/jobs' "$test_root/calls/gh"; then
  cat "$test_root/calls/gh"
  printf 'Expected the reused-branch run to be dropped before its jobs were read.\n' >&2
  exit 1
fi

printf 'Reused branch demand filtering passed.\n'

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

if ! grep --quiet 'Available memory 2g, headroom 2g' "$test_root/output"; then
  cat "$test_root/output"
  printf 'Expected the memory headroom decision in the supervisor log.\n' >&2
  exit 1
fi

# A RAM-backed filesystem spends the pages the pools budget, and `MemAvailable`
# cannot say so. Without this the reader sees only that memory is gone.
if ! grep --quiet 'RAM-backed filesystems hold [0-9]\+g; holding example-ci at 0' "$test_root/output"; then
  cat "$test_root/output"
  printf 'Expected the hold reason to name RAM-backed filesystem usage.\n' >&2
  exit 1
fi

printf 'Host memory headroom passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-enabled" "$test_root/calls/low-memory"

# Two queued jobs mean two spawn requests for the one pool. Every one of them
# has to re-run the gate. With all pools at 0 no job can return capacity, so a
# dropped request would hold the pool until something unrelated wrote to the
# pipe, which is how the pools stayed at 0 for an hour on 2026-09-04.
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

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected the supervisor to exit cleanly while the pool was held.\n' >&2
  exit 1
fi

holds="$(grep --count 'holding example-ci at 0' "$test_root/output" || true)"
if (( holds < 2 )); then
  cat "$test_root/output"
  printf 'Expected every queued job to re-run the gate, saw %s hold(s).\n' "$holds" >&2
  exit 1
fi

printf 'Repeated demand re-runs the memory gate passed.\n'

# The dashboard ages a hold from the marker's mtime. A gate re-run that
# rewrites the marker resets that start, so a hold ages past no snapshot.
# Two queued jobs mean two gate runs, and `slow-free` separates their marker
# writes by more than a second so the rewrite lands in a later mtime second.
rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-enabled" "$test_root/calls/low-memory" "$test_root/calls/slow-free"
cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|0|2|1|1g|2g|3g
EOF

set +e
(
  TEST_CALLS="$test_root/calls" \
  PATH="$test_root/bin:$PATH" \
  XDG_RUNTIME_DIR="$test_root/runtime" \
  CREDENTIALS_DIRECTORY="$test_root/credentials" \
  HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
  HARLAN_DESKTOP_RUNNER_CPU_BUDGET=4 \
  HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=2 \
  HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
  HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
  HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS=0.2 \
  HARLAN_DESKTOP_RUNNER_STATUS_OUTPUT="$test_root/calls/status.json" \
  timeout --preserve-status --kill-after=1 8 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
) &
supervisor_pid=$!

held_since_first=''
held_since_drifted=''
while kill -0 "$supervisor_pid" 2>/dev/null; do
  if [[ -s "$test_root/calls/status.json" ]]; then
    held_since="$(jq --raw-output '.pools[] | select(.name == "example-ci") | .heldSince // empty' "$test_root/calls/status.json" 2>/dev/null || true)"
    if [[ -n "$held_since" ]]; then
      if [[ -z "$held_since_first" ]]; then
        held_since_first="$held_since"
      elif [[ "$held_since" != "$held_since_first" ]]; then
        held_since_drifted="$held_since"
      fi
    fi
  fi
  sleep 0.05
done
wait "$supervisor_pid"
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected the supervisor to exit cleanly while the hold start was checked.\n' >&2
  exit 1
fi

holds="$(grep --count 'holding example-ci at 0' "$test_root/output" || true)"
if (( holds < 2 )); then
  cat "$test_root/output"
  printf 'Expected a second gate run behind the held marker, saw %s hold(s).\n' "$holds" >&2
  exit 1
fi

if [[ -z "$held_since_first" ]]; then
  cat "$test_root/calls/status.json"
  printf 'Expected the held pool to publish a hold start time.\n' >&2
  exit 1
fi

if [[ -n "$held_since_drifted" ]]; then
  cat "$test_root/output"
  printf 'Expected the published hold start %s to survive later gate runs, saw %s.\n' "$held_since_first" "$held_since_drifted" >&2
  exit 1
fi

printf 'Held start survives later gate runs passed.\n'

# A hold must end when its demand ends, not only when a capacity event
# arrives. The gate runs on spawn and capacity requests alone, so a run that
# is cancelled while its pool is held sends neither: the next scan publishes
# queued 0 and stays quiet, and no busy slot ever returns capacity. The
# marker then reports a hold over an idle pool until restart. Hold one cold
# pool at low memory, cancel its run with no other pools and no bursts, and
# require the published hold to clear within one demand scan.
rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-enabled" "$test_root/calls/low-memory"
cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|0|2|1|1g|2g|3g
EOF

set +e
(
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
  HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS=0.2 \
  HARLAN_DESKTOP_RUNNER_STATUS_OUTPUT="$test_root/calls/status.json" \
  timeout --preserve-status --kill-after=1 100 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
) &
supervisor_pid=$!

saw_hold=''
cancelled_demand=''
saw_queued_zero=''
held_cleared=''
while kill -0 "$supervisor_pid" 2>/dev/null; do
  pool_json="$(jq --compact-output '.pools[] | select(.name == "example-ci")' "$test_root/calls/status.json" 2>/dev/null || true)"
  if [[ -n "$pool_json" ]]; then
    held_reason="$(jq --raw-output '.heldReason // empty' <<<"$pool_json")"
    queued_count="$(jq --raw-output '.queued' <<<"$pool_json")"
    if [[ -n "$held_reason" ]]; then
      saw_hold=1
      if [[ -z "$cancelled_demand" ]]; then
        rm --force "$test_root/calls/queue-enabled"
        cancelled_demand=1
      fi
    fi
    [[ "$queued_count" == 0 ]] && saw_queued_zero=1
    if [[ -n "$saw_hold" && -n "$cancelled_demand" && -z "$held_reason" ]]; then
      held_cleared=1
    fi
  fi
  sleep 0.05
done
wait "$supervisor_pid"
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected the supervisor to exit cleanly while the hold end was checked.\n' >&2
  exit 1
fi

if [[ -z "$saw_hold" ]]; then
  cat "$test_root/output"
  printf 'Expected the low memory hold to publish a hold reason.\n' >&2
  exit 1
fi

if [[ -z "$saw_queued_zero" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/gh"
  printf 'Expected the cancelled run to publish a queued count of zero.\n' >&2
  exit 1
fi

if [[ -z "$held_cleared" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/status.json"
  printf 'Expected the published hold to clear once its queued count reached zero with no capacity event.\n' >&2
  exit 1
fi

printf 'Cancelled hold clears without a capacity event passed.\n'

rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-priority"
cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-busy|1|1|4|1g|2g|3g
harlan-zw/example|harlan-desktop-ci|0|1|4|1g|2g|3g
harlan-zw/example|harlan-desktop-deploy|0|1|12|1g|2g|3g
EOF

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_HISTORY_DIR="$test_root/history" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=12 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=12 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
timeout --preserve-status --kill-after=1 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected deploy priority scheduling to drain cleanly.\n' >&2
  exit 1
fi

if [[ "$(<"$test_root/calls/burst")" != *-deploy-burst-* ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/burst"
  printf 'Expected the pending deploy to receive released capacity first.\n' >&2
  exit 1
fi

if grep --quiet --fixed-strings -- '-ci-burst-' "$test_root/calls/burst"; then
  cat "$test_root/output"
  cat "$test_root/calls/burst"
  printf 'Expected CI admission to wait behind the pending deploy.\n' >&2
  exit 1
fi

printf 'Deploy priority passed.\n'

# A deploy run cancelled while its burst request is held must release the
# reservation. Scan one queues the deploy, scan two lists it gone, and only
# then does the busy slot return capacity. CI has to be admitted on the freed
# slot with no empty deploy burst in front of it. The second scan lands after
# the 60 second demand poll floor, so this block runs longer than the others.
# Once the held demand is dropped, the published hold must go too: a marker
# that survives the drop reports a healthy pool as held until restart.
rm -rf "$test_root/calls" "$test_root/runtime"
mkdir -p "$test_root/calls" "$test_root/runtime"
touch "$test_root/calls/queue-cancel" "$test_root/calls/hold-warm-job"

set +e
TEST_CALLS="$test_root/calls" \
PATH="$test_root/bin:$PATH" \
XDG_RUNTIME_DIR="$test_root/runtime" \
CREDENTIALS_DIRECTORY="$test_root/credentials" \
HARLAN_DESKTOP_RUNNER_CONFIG="$test_root/runners.conf" \
HARLAN_DESKTOP_RUNNER_HISTORY_DIR="$test_root/history" \
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=12 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=12 \
HARLAN_DESKTOP_RUNNER_DEMAND_POLL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_NOW_EPOCH=1787808600 \
HARLAN_DESKTOP_RUNNER_STATUS_INTERVAL_SECONDS=1 \
HARLAN_DESKTOP_RUNNER_STATUS_OUTPUT="$test_root/calls/status.json" \
timeout --preserve-status --kill-after=1 70 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 0 )); then
  cat "$test_root/output"
  printf 'Expected the cancelled deploy reservation to drain cleanly.\n' >&2
  exit 1
fi

if ! grep --quiet -- '-ci-burst-' "$test_root/calls/burst" 2>/dev/null; then
  cat "$test_root/output"
  [[ -f "$test_root/calls/burst" ]] && cat "$test_root/calls/burst"
  printf 'Expected CI to be admitted once the deploy demand vanished.\n' >&2
  exit 1
fi

if grep --quiet -- '-deploy-burst-' "$test_root/calls/burst" 2>/dev/null; then
  cat "$test_root/calls/burst"
  printf 'Expected the cancelled deploy not to burst an empty runner.\n' >&2
  exit 1
fi

if ! jq --exit-status '.pools[] | select(.name == "example-deploy") | .heldReason == null and .heldSince == null' "$test_root/calls/status.json" >/dev/null; then
  cat "$test_root/calls/status.json"
  printf 'Expected the dropped deploy demand to clear the published hold.\n' >&2
  exit 1
fi

printf 'Cancelled deploy reservation passed.\n'

if [[ -n "$(find "$state_home" -mindepth 1 -print -quit)" ]]; then
  find "$state_home"
  printf 'Expected every invocation to keep job history inside the test root.\n' >&2
  exit 1
fi
