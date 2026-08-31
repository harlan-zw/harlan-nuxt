#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

history_dir="$test_root/history"
old_started_at="$(( $(date --utc --date='2026-05-01T00:00:00Z' +%s) * 1000 ))"
recent_started_at="$(( $(date --utc --date='2026-08-30T00:00:00Z' +%s) * 1000 ))"
now_epoch="$(date --utc --date='2026-08-31T00:00:00Z' +%s)"

cat >"$test_root/jobs.ndjson" <<EOF
{"completedAt":$(( old_started_at + 61000 )),"name":"old build","outcome":"Succeeded","pool":"example-ci","repository":"harlan-zw/example","startedAt":$old_started_at}
{"completedAt":$(( recent_started_at + 90000 )),"name":"build","outcome":"Succeeded","pool":"example-ci","repository":"harlan-zw/example","startedAt":$recent_started_at}
{"completedAt":$(( recent_started_at + 130000 )),"name":"lint","outcome":"Failed","pool":"example-ci","repository":"harlan-zw/example","startedAt":$(( recent_started_at + 120000 ))}
{"completedAt":$(( recent_started_at + 90000 )),"name":"build","outcome":"Succeeded","pool":"example-ci","repository":"harlan-zw/example","startedAt":$recent_started_at}
EOF

HARLAN_DESKTOP_RUNNER_NOW_EPOCH="$now_epoch" \
HARLAN_DESKTOP_RUNNER_RAW_RETENTION_DAYS=90 \
./infra/github-runner/job-history import "$history_dir" <"$test_root/jobs.ndjson"

if [[ -e "$history_dir/jobs/2026-05-01.ndjson" ]]; then
  printf 'Expected raw jobs older than 90 days to be removed.\n' >&2
  exit 1
fi

if (( $(wc -l <"$history_dir/jobs/2026-08-30.ndjson") != 2 )); then
  printf 'Expected repeated imports to keep each raw job once.\n' >&2
  exit 1
fi

jq --exit-status '
  .date == "2026-05-01"
  and .actualMilliseconds == 61000
  and .billableMinutes == 2
  and .completed == 1
  and .trackedSince == $started
' --argjson started "$old_started_at" "$history_dir/daily/2026-05-01.json" >/dev/null

jq --exit-status '
  .date == "2026-08-30"
  and .actualMilliseconds == 100000
  and .billableMinutes == 3
  and .completed == 2
  and .trackedSince == $started
' --argjson started "$recent_started_at" "$history_dir/daily/2026-08-30.json" >/dev/null

before_checksum="$(sha256sum "$history_dir/daily/2026-08-30.json")"
set +e
printf '%s\n' '{"completedAt":"invalid"}' \
  | ./infra/github-runner/job-history import "$history_dir" >/dev/null 2>&1
invalid_status=$?
set -e
if (( invalid_status == 0 )) || [[ "$(sha256sum "$history_dir/daily/2026-08-30.json")" != "$before_checksum" ]]; then
  printf 'Expected invalid imports to preserve runner history.\n' >&2
  exit 1
fi

printf 'Runner job history passed.\n'
