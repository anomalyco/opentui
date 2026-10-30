#!/usr/bin/env bash
# Slow-link rows on this machine: 48 KB/s and unlimited, writer on and OTUI_STDOUT_THREAD=0.
# usage: run.sh REPO LIB PYTHON_WITH_PYTE
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$1 lib=$2 py=$3
cd "$here"
env -u OTUI_STDOUT_THREAD python3 harness.py on-48k --tree "$repo" --lib "$lib" --rate 48000 --secs 20
OTUI_STDOUT_THREAD=0 python3 harness.py off-48k --tree "$repo" --lib "$lib" --rate 48000 --secs 20
env -u OTUI_STDOUT_THREAD python3 harness.py on-unl --tree "$repo" --lib "$lib" --rate 0 --delay 0 --secs 10
OTUI_STDOUT_THREAD=0 python3 harness.py off-unl --tree "$repo" --lib "$lib" --rate 0 --delay 0 --secs 10
"$py" analyze.py on-48k off-48k on-unl off-unl
"$py" verdict.py runs
