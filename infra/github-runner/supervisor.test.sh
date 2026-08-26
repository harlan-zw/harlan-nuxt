#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/runtime" "$test_root/calls" "$test_root/credentials"
printf 'repository-token\n' >"$test_root/credentials/github-harlan-zw-token"

cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-ci|1|2|1|1g|2g
EOF

cat >"$test_root/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${GH_TOKEN:-}" != repository-token ]]; then
  printf 'Expected the repository credential.\n' >&2
  exit 1
fi
if [[ "$*" == *registration-token* ]]; then
  printf 'test-token\n'
fi
EOF

cat >"$test_root/bin/free" <<'EOF'
#!/usr/bin/env bash
printf 'Mem: 32\n'
EOF

cat >"$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
shift || true
printf '%s %s\n' "$command_name" "$*" >>"$TEST_CALLS/docker"

case "$command_name" in
  image|volume|rm|stop)
    exit 0
    ;;
  ps)
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
HARLAN_DESKTOP_RUNNER_CPU_BUDGET=1 \
HARLAN_DESKTOP_RUNNER_MEMORY_BUDGET_GIB=1 \
HARLAN_DESKTOP_RUNNER_BURST_IDLE_SECONDS=30 \
timeout 2 ./infra/github-runner/supervisor >"$test_root/output" 2>&1
status=$?
set -e

if (( status != 124 )); then
  cat "$test_root/output"
  printf 'Expected the supervisor test process to reach its timeout.\n' >&2
  exit 1
fi

if [[ ! -s "$test_root/calls/burst" ]]; then
  cat "$test_root/output"
  cat "$test_root/calls/docker"
  printf 'Expected released capacity to start the denied burst runner.\n' >&2
  exit 1
fi

printf 'Capacity retry passed.\n'
