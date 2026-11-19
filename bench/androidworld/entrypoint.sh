#!/bin/sh
# W3-6 E4: forward android_env's fixed local addresses to the host (see Dockerfile), then run the service.
set -e
HOST="${AW_HOST_GATEWAY:-host.docker.internal}"
socat TCP-LISTEN:5037,bind=127.0.0.1,fork,reuseaddr "TCP:${HOST}:5037" &
socat TCP-LISTEN:8554,bind=127.0.0.1,fork,reuseaddr "TCP:${HOST}:${AW_GRPC_PORT:-8554}" &
sleep 0.5
adb version | head -1
adb devices
exec python server.py --host 0.0.0.0 --a11y-port "${AW_A11Y_PORT:-5056}" --adb "$(command -v adb)" "$@"
