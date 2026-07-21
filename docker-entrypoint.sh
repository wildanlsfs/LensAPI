#!/bin/sh
set -e

# Runs as root (the container's default user until this script hands off
# below). Coolify's volume mount at /app/src/storage attaches *after* the
# image's own `chown -R node:node /app` ran at build time, so the mount
# point's ownership on the host wins and can shadow that with root (or a
# different uid) — the app (running as the non-root `node` user) then can't
# write uploads there. Fix ownership at container start, every start, so it's
# correct regardless of how the volume happened to be created.
chown -R node:node /app/src/storage

# Hand off to the app as the non-root `node` user — gosu avoids the signal-
# handling/zombie-process issues of `su`/`sudo` for PID 1 in containers.
exec gosu node "$@"
