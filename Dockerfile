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
# instead of creating a new one. Ownership must be fixed up before
# dropping privileges so the app can write uploaded files and node-cron
# can delete expired ones under /app/src/storage.
RUN chown -R node:node /app
USER node

# Minimal-image note: node:20-bookworm-slim does not include curl, and we
# don't want to add a dependency just for a health probe. Node's built-in
# http module can make the same GET /health request with zero extra
# packages, so we use that instead of installing curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "src/index.js"]
