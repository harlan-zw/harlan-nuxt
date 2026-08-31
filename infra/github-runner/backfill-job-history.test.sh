#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir --parents "$test_root/bin"
cat >"$test_root/bin/gh" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_GH_LOG"
case "$*" in
  *'/actions/runs?'*)
    printf '%s\n' '{"workflow_runs":[{"id":77}]}'
    ;;
  *'/actions/runs/77/jobs?'*)
    printf '%s\n' '{"jobs":[{"completed_at":"2026-08-30T00:01:30Z","conclusion":"success","labels":["self-hosted","example-linux"],"name":"build","runner_name":"harlan-desktop-example-linux-x64-01","started_at":"2026-08-30T00:00:00Z","status":"completed"},{"completed_at":"2026-08-30T00:02:00Z","conclusion":"success","labels":["ubuntu-latest"],"name":"hosted build","runner_name":"GitHub Actions 1","started_at":"2026-08-30T00:00:00Z","status":"completed"}]}'
    ;;
  *)
    printf 'Unexpected GitHub API request: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$test_root/bin/gh"

cat >"$test_root/runners.conf" <<'EOF'
harlan-zw/example|harlan-desktop-linux-x64,example-linux|2|node22
harlan-zw/example|harlan-desktop-linux-x64,example-linux|2|node22
EOF

output="$(
  PATH="$test_root/bin:$PATH" \
  FAKE_GH_LOG="$test_root/gh.log" \
  HARLAN_DESKTOP_RUNNER_NOW_EPOCH="$(date --utc --date='2026-08-31T00:00:00Z' +%s)" \
    ./infra/github-runner/backfill-job-history \
      "$test_root/history" \
      "$test_root/runners.conf" \
      2026-08-01 \
      2026-08-31
)"

if [[ "$output" != 'Imported 1 Runner jobs.' ]]; then
  printf 'Expected one self-hosted Runner job to be imported.\n' >&2
  exit 1
fi

if (( $(wc --lines <"$test_root/gh.log") != 2 )); then
  printf 'Expected repeated repositories to be queried once.\n' >&2
  exit 1
fi

jq --exit-status '
  .actualMilliseconds == 90000
  and .billableMinutes == 2
  and .completed == 1
  and .trackedSince == 1788048000000
' "$test_root/history/daily/2026-08-30.json" >/dev/null

jq --exit-status '
  .repository == "harlan-zw/example"
  and .pool == "example-linux-x64"
  and .outcome == "Succeeded"
' "$test_root/history/jobs/2026-08-30.ndjson" >/dev/null

printf 'Runner job history backfill passed.\n'
