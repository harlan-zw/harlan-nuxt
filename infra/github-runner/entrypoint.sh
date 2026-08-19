#!/usr/bin/env bash

# Registers one ephemeral runner, then hands the process to the runner listener.
# The supervisor reads this container's stdout, so every line the runner prints
# is a signal. Do not add quiet flags.

set -euo pipefail

if ! IFS= read -r registration_token || [[ -z "$registration_token" ]]; then
  echo 'Runner registration token was not provided on stdin.' >&2
  exit 1
fi

./config.sh \
  --disableupdate \
  --ephemeral \
  --labels "${RUNNER_LABELS}" \
  --name "${RUNNER_NAME}" \
  --token "$registration_token" \
  --unattended \
  --url "${RUNNER_URL}" \
  --work _work

registration_token=''
unset registration_token

exec ./run.sh
