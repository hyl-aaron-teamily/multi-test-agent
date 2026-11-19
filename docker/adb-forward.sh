#!/bin/sh
# W3-5 E2: forward localhost:5037 to the host adb server (ADB_SERVER_SOCKET=tcp:<host>:<port>), then run the command.
target="${ADB_SERVER_SOCKET#tcp:}"
case "$target" in
  localhost:*|127.0.0.1:*|"") ;;
  *) socat TCP-LISTEN:5037,bind=127.0.0.1,fork,reuseaddr "TCP:${target}" & ;;
esac
exec "$@"
