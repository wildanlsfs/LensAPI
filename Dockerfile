# ---- deps stage -------------------------------------------------------
# Installs only production dependencies. Isolated in its own stage (and
# copied via COPY --from=deps below) purely so the npm cache/layer this
# produces only invalidates when package*.json changes, not on every
# source edit — keeps rebuilds fast in Coolify.
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Only the manifest + lockfile first, so this layer caches independently
# of source changes.
COPY package.json package-lock.json ./

# `npm ci` requires package-lock.json to be present and in sync with
# package.json — it fails hard on drift instead of silently re-resolving,
# which is exactly the guarantee we want for reproducible prod installs.
# sharp (a transitive dep of chrome-lens-ocr) ships prebuilt binaries for
# glibc/Debian, so no build toolchain is needed here.
RUN npm ci --omit=dev

# ---- runtime stage ------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Bring in only the resolved production node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Application source, copied after dependencies so editing src/ doesn't
# bust the (much slower) npm ci layer above.
COPY src ./src

# Default port, matches .env.example's PORT default. Coolify probes the
# first exposed port by default.
EXPOSE 3000

# Persistent volume mount point for uploaded images (STORAGE_PATH). The
# app's own default (config.js) is the relative path ./src/storage, which
# resolves against WORKDIR (/app) to /app/src/storage inside this image —
# create it up front so a bind mount/volume has somewhere to attach, and
# so the app can write to it even before any volume is mounted.
RUN mkdir -p /app/src/storage

# Run as a non-root user for defense in depth. The official Node image
# already ships a low-privilege `node` user (uid/gid 1000) — reuse it
# instead of creating a new one. This chown covers the image's own layers;
# it does NOT cover whatever gets mounted at /app/src/storage at runtime
# (a Coolify/Docker volume's ownership on the host wins over this), which
# is why docker-entrypoint.sh re-fixes ownership at container start too.
RUN chown -R node:node /app

# gosu lets the entrypoint start as root (needed to chown the mounted
# volume, which a non-root user can't do) and then drop to the `node` user
# before actually running the app — safer than `su`/`sudo` for PID 1 in
# containers (proper signal forwarding, no extra shell/zombie process).
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Container starts as root (image default) so the entrypoint can chown the
# mounted volume; it execs into the `node` user itself before running CMD,
# so the application process never actually runs as root.
ENTRYPOINT ["docker-entrypoint.sh"]

# Minimal-image note: node:20-bookworm-slim does not include curl, and we
# don't want to add a dependency just for a health probe. Node's built-in
# http module can make the same GET /health request with zero extra
# packages, so we use that instead of installing curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "src/index.js"]
