#!/usr/bin/env bash

# Hands the process to the runner listener with the just-in-time config the
# supervisor minted. There is no `config.sh` step: the config already names the
# runner, its labels, and its one-job lifetime.
# The supervisor reads this container's stdout, so every line the runner prints
# is a signal. Do not add quiet flags.

set -euo pipefail

if ! IFS= read -r jit_config || [[ -z "$jit_config" ]]; then
  echo 'Runner just-in-time config was not provided on stdin.' >&2
  exit 1
fi

exec ./run.sh --jitconfig "$jit_config"
