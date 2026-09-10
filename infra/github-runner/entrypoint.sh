#!/usr/bin/env bash

# Hands the process to the runner listener with the just-in-time config the
# supervisor minted. There is no `config.sh` step: the config already names the
# runner, its labels, and its one-job lifetime.
# Self-update cannot be disabled on this path: `--disableupdate` belongs to
# `config.sh`, and `run.sh --jitconfig` rejects it. The README carries the
# update story: rebuild the image promptly after each runner release.
# The supervisor reads this container's stdout, so every line the runner prints
# is a signal. Do not add quiet flags.

set -euo pipefail

if ! IFS= read -r jit_config || [[ -z "$jit_config" ]]; then
  echo 'Runner just-in-time config was not provided on stdin.' >&2
  exit 1
fi

exec ./run.sh --jitconfig "$jit_config"
