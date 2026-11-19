# W3-5 E2: the platform in a container. The devices stay on the host: the container is an adb *client* of the host's
# adb server (ADB_SERVER_SOCKET=tcp:host.docker.internal:5037) and reads the tree service through that server's
# socket (core/adb-socket.ts), so no adb server and no forwards live in here.
#
# The adb client MUST be the host's version (37.0.1): a client of another version makes the server restart and
# the test phone drops off (`doctor` refuses to start on a mismatch). Change ADB_VERSION together with the host.
FROM node:22-bookworm-slim

ARG ADB_VERSION=37.0.1
ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/opt/platform-tools:$PATH \
    AUTOTEST_IN_CONTAINER=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip ffmpeg socat \
 && curl -fsSL -o /tmp/pt.zip "https://dl.google.com/android/repository/platform-tools_r${ADB_VERSION}-linux.zip" \
 && unzip -q /tmp/pt.zip -d /opt && rm /tmp/pt.zip \
 && /opt/platform-tools/adb version | head -2 \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Web surfaces are not run this milestone (D8): no Playwright browsers in the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 3210
# Midscene's adb wrapper runs `adb -P 5037 …`, which ignores ADB_SERVER_SOCKET and would start an empty adb
# server in here: localhost:5037 is forwarded to the host's server instead (docker/adb-forward.sh).
COPY docker/adb-forward.sh /usr/local/bin/adb-forward
RUN chmod +x /usr/local/bin/adb-forward
ENTRYPOINT ["adb-forward"]
CMD ["pnpm", "platform"]
