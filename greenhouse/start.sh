#!/bin/sh
set -eu
python3 -c 'from pathlib import Path; Path("/data/console.sock").unlink(missing_ok=True)'
/greenhouse/greenhouse-console &
console_pid=$!
attempt=0
while [ ! -S /data/console.sock ]; do
  if ! kill -0 "$console_pid" 2>/dev/null; then
    echo 'specimen console failed to start' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo 'specimen console socket not ready' >&2
    exit 1
  fi
  sleep 0.1
done
exec python3 /greenhouse/app/server.py
