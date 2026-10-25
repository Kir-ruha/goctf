#!/bin/sh
set -eu
cmake -S /srv/lighthouse/server -B /tmp/lighthouse-build
cmake --build /tmp/lighthouse-build -j"$(nproc)"
install -m 0755 /tmp/lighthouse-build/lighthouse /srv/lighthouse/server/lighthouse
