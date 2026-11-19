# W3-6 E4: the AndroidWorld bench service (bench/androidworld/server.py) in a container.
# Build context: this directory; the AndroidWorld source comes in as the named context `aw` (docker-compose.yml:
# ./ref/android_world, read-only — COPY never writes to it).
#
# The emulator (AndroidWorldAvd, emulator-5554) stays on the host. android_env talks to it at fixed local
# addresses, so entrypoint.sh forwards them to the host:
#   localhost:5037 → host adb server (android_env runs `adb -P 5037 …`; the server is shared with the phone and
#                    server.py refuses `adb kill-server`)
#   localhost:8554 → the emulator's gRPC port (`-grpc 8554`)
# and the accessibility forwarder inside the emulator dials 10.0.2.2:<port> (the host): the port is fixed
# (--a11y-port, 5056) and published to the host's 127.0.0.1, so that dial reaches this container.
#
# The adb client MUST be the host's version (37.0.1), as in the platform image.
FROM python:3.11-slim-bookworm

ARG ADB_VERSION=37.0.1
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/platform-tools:$PATH \
    PYTHONUNBUFFERED=1

# libgl1 / libglib2.0-0: opencv-python. socat: the forwards above. Debian's sqlite has FTS4 (Joplin setup).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip socat libgl1 libglib2.0-0 \
 && curl -fsSL -o /tmp/pt.zip "https://dl.google.com/android/repository/platform-tools_r${ADB_VERSION}-linux.zip" \
 && unzip -q /tmp/pt.zip -d /opt && rm /tmp/pt.zip \
 && /opt/platform-tools/adb version | head -2 \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=aw requirements.txt /opt/android_world/requirements.txt
RUN pip install --no-cache-dir -r /opt/android_world/requirements.txt fastapi uvicorn
COPY --from=aw . /opt/android_world
RUN pip install --no-cache-dir --no-deps /opt/android_world

WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 5055 5056
ENTRYPOINT ["./entrypoint.sh"]
