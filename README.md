# LensAPI

Self-hosted, unofficial Google Lens OCR API. A chat app calls this service over HTTP so users
can extract text from images (JPEG/PNG/WebP) without leaving the chat app — upload an image,
get back the OCR'd text, per-segment bounding boxes, and a couple of convenience links.

Built on [`chrome-lens-ocr`](https://github.com/dimdenGD/chrome-lens-ocr), a reverse-engineered
client for Google Lens's internal OCR endpoint — this is **not** an official Google API (see
[Known limitations](#known-limitations)).

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Local development](#local-development)
- [Configuration](#configuration)
- [API overview](#api-overview)
- [Docker](#docker)
- [Deploying on Coolify](#deploying-on-coolify)
- [Deploying on any other Docker host](#deploying-on-any-other-docker-host)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Docs index](#docs-index)

## Features

- **OCR via `POST /v1/ocr`** — upload an image, get back extracted text, detected language,
  per-line bounding boxes, auto-detected URLs, and a generated "search this text" link.
- **Auto-expiring storage** — uploaded images live on local disk and are deleted automatically
  after a configurable retention window (default 7 days) via a daily cleanup job.
- **Service-to-service auth** — a single shared `X-API-Key` gates the upload endpoint; no
  per-user accounts to manage.
- **Two-tier health checks** — `GET /health` for plain liveness, `GET /health/lens` to detect
  when Google's upstream endpoint itself is broken or blocked, independent of the service.
- **Coolify-ready** — multi-stage Dockerfile, persistent-volume-friendly storage layout, and a
  documented deployment walkthrough.

## Tech stack

| | |
|---|---|
| Runtime | Node.js 20, ESM |
| Framework | Express 5 |
| OCR | [`chrome-lens-ocr`](https://github.com/dimdenGD/chrome-lens-ocr) |
| Uploads | Multer (disk storage) |
| Scheduling | node-cron |
| Security | Helmet, CORS, `express-rate-limit`, API-key auth |
| Deployment | Docker (`node:20-bookworm-slim`), Coolify |

## Project structure

```
src/
  index.js              Express app entrypoint
  config.js              Env var loading + defaults
  errors/
    LensUpstreamError.js  Tags upstream Lens failures for the error handler
  middleware/
    auth.js               X-API-Key check
    rateLimit.js           IP-based rate limiting
    errorHandler.js        Central error → HTTP response mapping
  routes/
    ocr.js                 POST /v1/ocr
    health.js               GET /health, GET /health/lens
  services/
    lens.js                 chrome-lens-ocr wrapper (singleton instance)
    links.js                 URL detection + search-link generation
    cleanup.js               Retention cleanup job (runCleanup / scheduleCleanup)
  fixtures/
    health-check.jpg         Bundled test image for /health/lens
  storage/                   Uploaded images live here (gitignored, .gitkeep tracked)
```

## Local development

```bash
npm install
cp .env.example .env   # then fill in API_KEY at minimum
npm start                # or: npm run dev (nodemon)
```

The server binds `0.0.0.0:$PORT` (default `3000`). Confirm it's up:

```bash
curl localhost:3000/health
```

## Configuration

All configuration is via environment variables (see [.env.example](./.env.example)):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (binds `0.0.0.0`) |
| `API_KEY` | *(empty)* | Shared secret required via `X-API-Key` on `/v1/ocr`. Auth fails closed if unset — set a real value before exposing this service. |
| `STORAGE_PATH` | `./src/storage` | Local directory uploaded images are written to |
| `RETENTION_DAYS` | `7` | Days an uploaded image is kept before the daily cleanup job deletes it |
| `MAX_FILE_SIZE_MB` | `10` | Max accepted upload size |
| `LENS_COOKIE` | *(empty)* | Optional cookie string passed to `chrome-lens-ocr`, useful if Google starts blocking/rate-limiting the server's IP |
| `LENS_PROXY_URL` | *(empty)* | Optional proxy URL passed to `chrome-lens-ocr`'s fetch dispatcher, same purpose as above |

## API overview

- `POST /v1/ocr` — multipart/form-data upload, field name `image` (JPEG/PNG/WebP, max
  `MAX_FILE_SIZE_MB`). Requires an `X-API-Key` header matching the server's `API_KEY`. Returns
  OCR text, segments with bounding boxes, and detected/search links.
- `GET /health` — liveness only (process up). This is what Coolify's health check probes.
- `GET /health/lens` — deeper check that exercises `chrome-lens-ocr` against a bundled test
  image, so you can tell "the service is up but Google Lens itself is unreachable/blocked"
  apart from plain process liveness.

Full endpoint-by-endpoint reference (request/response shapes, every error code, field-by-field
rendering guidance for the chat app) lives in **[API.md](./API.md)** — that's the doc to hand
to whoever's integrating this into the chat app backend.

## Docker

Build and run locally:

```bash
docker build -t lensapi .
docker run -d \
  --name lensapi \
  -p 3000:3000 \
  --env-file .env \
  -v lensapi-storage:/app/src/storage \
  lensapi
```

Notes on the image:

- Base image is `node:20-bookworm-slim` (glibc/Debian), not Alpine — `sharp` (a transitive
  dependency via `chrome-lens-ocr`) ships prebuilt native binaries per platform/libc, and
  bookworm-slim avoids the extra musl-binary edge cases that come with Alpine.
- Multi-stage build: dependencies are installed (`npm ci --omit=dev`) in a separate stage from
  where the source is copied in, so editing application code doesn't invalidate the
  (much slower) dependency-install layer on rebuild.
- **Runs as a non-root user, but starts as root.** `ENTRYPOINT` is
  [`docker-entrypoint.sh`](./docker-entrypoint.sh), which runs as root just long enough to
  `chown` the mounted storage volume to the image's built-in `node` user (uid/gid 1000), then
  hands off to the actual app process as `node` via `gosu`. This matters because **a mounted
  volume's ownership on disk overrides whatever `chown` happened at build time** — without this
  entrypoint step, the app would get `EACCES: permission denied` trying to write uploads the
  moment persistent storage is attached (see [Troubleshooting](#troubleshooting)). The
  application itself never runs as root; only the brief startup step does.
- `HEALTHCHECK` hits `GET /health` using a small inline Node script (the `http` built-in) —
  intentionally not `curl`, since `node:20-bookworm-slim` doesn't include it and we didn't want
  to add it just for this.

### Storage path inside the container

The app's default `STORAGE_PATH` (from `.env.example`) is the relative path `./src/storage`,
which resolves against the image's `WORKDIR` (`/app`) to **`/app/src/storage`**. The Dockerfile
creates that directory at build time. When deploying, mount your persistent volume at
`/app/src/storage` (matching the app's own default — no `STORAGE_PATH` override needed), **or**
set `STORAGE_PATH=/app/storage` explicitly and mount there instead if you'd rather use a
top-level path. Either works; just make sure the env var (if you set one) and the volume's mount
path agree. Whichever path you choose, `docker-entrypoint.sh` only `chown`s
`/app/src/storage` — if you override `STORAGE_PATH` to a different path, update the entrypoint
script's `chown` target to match, or the permission fix won't apply to the path the app actually
writes to.

The examples below use the no-override default, `/app/src/storage`.

## Deploying on Coolify

1. **Create the app.** In Coolify, add a new Application, connect this git repository, and
   explicitly select **"Dockerfile"** as the build pack (don't rely on auto-detection).
2. **Add persistent storage.** In the app's **Storage** tab, add a **Volume Mount** (not
   *Directory Mount* or *File Mount* — those are for bind-mounting a specific host path or a
   single file, not a Docker-managed volume):
   - **Name**: any label, e.g. `lensapi-storage`.
   - **Source Path**: leave empty — Docker manages the volume's actual location on the host.
   - **Destination Path**: `/app/src/storage` (must match the app's `STORAGE_PATH`, see above).

   This is what makes uploads survive redeploys; without it, every deploy wipes pending/retained
   files.
3. **Set environment variables** in Coolify's UI, Runtime scope — see [Configuration](#configuration)
   for the full list. At minimum:
   - `PORT` — e.g. `3000` (match whatever you set as the exposed port in step 4).
   - `API_KEY` — a strong random shared secret for the `X-API-Key` header (e.g.
     `openssl rand -hex 32`). **Auth fails closed if this is unset** — every request to
     `/v1/ocr` gets `401`, regardless of what key the caller sends — so leaving it blank doesn't
     mean "open," it means "unusable." Generate a real value and don't commit it anywhere.
   - `STORAGE_PATH` — only set this if you chose a different mount path in step 2; otherwise
     leave unset and the app's `./src/storage` default resolves correctly.
4. **Port + health check.** Set the exposed port to match `PORT`. The app binds `0.0.0.0`, and
   Coolify probes the first exposed port by default. This image also ships a Dockerfile
   `HEALTHCHECK` hitting `GET /health` — per Coolify's docs, the Dockerfile `HEALTHCHECK` takes
   precedence over any health check configured in the Coolify UI if both are set, so there's
   nothing extra to configure there, but confirm the UI's health-check path (if shown) also
   points at `/health`.
5. **Deploy and verify.** After deploy, confirm both:
   ```bash
   curl https://<your-domain>/health
   curl https://<your-domain>/health/lens
   ```
   `/health` should return `{"status":"ok"}` immediately (process liveness). `/health/lens`
   exercises a real call to Google's Lens endpoint and can legitimately take longer / fail
   independently of `/health` — see [Known limitations](#known-limitations). Then confirm a real
   upload works end to end (see [API.md](./API.md) for the full request contract):
   ```bash
   curl -X POST https://<your-domain>/v1/ocr \
     -H "X-API-Key: <your API_KEY>" \
     -F "image=@src/fixtures/health-check.jpg"
   ```
   This last check specifically exercises the mounted volume's write path — if step 2's mount
   point doesn't match `STORAGE_PATH`, or the volume has a permission problem, this is the
   request that will fail even though `/health` and `/health/lens` both pass. See
   [Troubleshooting](#troubleshooting) if it returns `500`.

## Deploying on any other Docker host

The image is a plain multi-stage Dockerfile with no Coolify-specific dependencies, so it runs
the same way on any Docker host (a VPS, ECS, Kubernetes via a Deployment + PVC, Docker Swarm,
etc.). The two things that matter anywhere you deploy it:

1. **A named volume (or equivalent persistent storage) mounted at the app's `STORAGE_PATH`**
   (default `/app/src/storage`) — without it, uploads vanish on every container recreate.
2. **`API_KEY` set to a real value** — the service is unusable (not insecure, just unusable)
   without it, by design.

### Plain `docker run`

```bash
docker volume create lensapi-storage

docker run -d \
  --name lensapi \
  --restart unless-stopped \
  -p 3000:3000 \
  -e API_KEY="$(openssl rand -hex 32)" \
  -e RETENTION_DAYS=7 \
  -e MAX_FILE_SIZE_MB=10 \
  -v lensapi-storage:/app/src/storage \
  lensapi
```

Swap in your own `API_KEY` if you're generating it separately (e.g. to share the exact same
value with your chat app backend) rather than letting the shell generate a throwaway one.

### `docker-compose.yml`

There's no `docker-compose.yml` committed to this repo — the project deliberately sticks to a
plain Dockerfile plus a manually-configured volume (matching how it's deployed on Coolify, see
above). If you'd rather run it via Compose on a different host, this is equivalent to the
`docker run` command above:

```yaml
services:
  lensapi:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      API_KEY: "changeme-generate-a-real-key"
      RETENTION_DAYS: "7"
      MAX_FILE_SIZE_MB: "10"
    volumes:
      - lensapi-storage:/app/src/storage

volumes:
  lensapi-storage:
```

Same rules apply as everywhere else: `API_KEY` needs a real generated value (`openssl rand -hex
32`) before this is usable, and the volume's mount path must match `STORAGE_PATH` if you
override it.

## Troubleshooting

**`POST /v1/ocr` returns `500 {"error":"internal_error"}`, but `GET /health` and `GET
/health/lens` both return `200`.**
This isolates the failure to the file-write step, almost always a volume permission problem.
Check the container logs for `EACCES: permission denied, open 'src/storage/...'`. This happens
when a freshly created/mounted volume has different ownership than what the image's `node` user
(uid 1000) expects — a mounted volume's ownership on disk always overrides whatever `chown`
happened in the image at build time. `docker-entrypoint.sh` (see [Docker](#docker) above) fixes
this automatically on every container start by re-`chown`ing the mounted path before dropping to
the non-root user — if you're seeing this error, confirm you're running the current image (the
entrypoint script needs to actually be present and executed; check `docker logs` for the
container starting cleanly, and confirm `ENTRYPOINT`/`docker-entrypoint.sh` weren't
removed/bypassed in a custom build).

**Every request, including `GET /health`, returns a plain-text `502` instead of JSON.**
Check the response headers (`curl -D -`). If you see `server: cloudflare` (or another
reverse-proxy) rather than a normal JSON body, the failure is happening at the proxy/load
balancer in front of the app — the container itself isn't responding at all. This usually means
the container is down, crash-looping, or the wrong port is configured in front of it (Coolify's
exposed port must match the app's `PORT`). Check `docker logs` / Coolify's deployment logs for
the actual crash, rather than debugging the app's code — a real app-level error always comes
back as JSON, never plain text, since this service sets `Content-Type: application/json` on
every response including errors.

**Rate limiting seems to key on the wrong IP, or logs show
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.**
This happens when the app is behind a reverse proxy (Coolify's Traefik, Cloudflare, etc.) that
sets `X-Forwarded-For`, but Express doesn't trust it by default — `express-rate-limit` refuses
to key on a header it can't verify came from a real proxy, to avoid spoofing. `src/index.js`
sets `app.set('trust proxy', 1)` to trust exactly one hop, which is correct for the standard
Coolify/Cloudflare setup (one reverse proxy in front of the app). If you put additional proxies
in front of that (e.g. your own load balancer in addition to Coolify's), you may need to adjust
this value — see [Express's `trust proxy` docs](https://expressjs.com/en/guide/behind-proxies.html).

**Docker build fails with a TLS handshake timeout resolving `docker/dockerfile:1`.**
This is a transient network issue on the build host reaching Docker Hub to resolve the BuildKit
syntax frontend, not a problem with the Dockerfile itself — retry the build. This Dockerfile
doesn't use any BuildKit-exclusive syntax, so it doesn't need a `# syntax=` pragma at all.

## Known limitations

- **Unofficial upstream.** This service depends on a reverse-engineered Google Lens endpoint
  (via `chrome-lens-ocr`), not a supported Google API. Google can change or block it without
  notice, and upstream has recurring reports of intermittent non-200/303 errors. `GET
  /health/lens` exists specifically so you can detect "Lens itself is broken/blocked" as a
  distinct condition from "the service process is down" — monitor it separately from `/health`.
- **OCR only.** No reverse image search / visual product matches — text extraction and
  bounding boxes only.
- **No image retrieval.** There's no endpoint to fetch an uploaded image back by id; images
  are write-once and auto-deleted after `RETENTION_DAYS`.

## Docs index

| Doc | Purpose |
|---|---|
| [PRD.md](./PRD.md) | Full functional/non-functional spec |
| [API.md](./API.md) | Endpoint-by-endpoint API reference for integrators |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Phased build history |
