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
- [Coolify deployment](#coolify-deployment)
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
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/storage-data:/app/src/storage" \
  lensapi
```

Notes on the image:

- Base image is `node:20-bookworm-slim` (glibc/Debian), not Alpine — `sharp` (a transitive
  dependency via `chrome-lens-ocr`) ships prebuilt native binaries per platform/libc, and
  bookworm-slim avoids the extra musl-binary edge cases that come with Alpine.
- Multi-stage build: dependencies are installed (`npm ci --omit=dev`) in a separate stage from
  where the source is copied in, so editing application code doesn't invalidate the
  (much slower) dependency-install layer on rebuild.
- The container runs as the image's built-in non-root `node` user, not root. `/app` (including
  the default storage directory) is `chown`'d to that user in the Dockerfile so the app can
  still write uploads and the retention job can still delete expired files.
- `HEALTHCHECK` hits `GET /health` using a small inline Node script (the `http` built-in) —
  intentionally not `curl`, since `node:20-bookworm-slim` doesn't include it and we didn't want
  to add it just for this.

### Storage path inside the container

The app's default `STORAGE_PATH` (from `.env.example`) is the relative path `./src/storage`,
which resolves against the image's `WORKDIR` (`/app`) to **`/app/src/storage`**. The Dockerfile
creates that directory and owns it as the `node` user. When deploying, mount your persistent
volume at `/app/src/storage` (matching the app's own default — no `STORAGE_PATH` override
needed), **or** set `STORAGE_PATH=/app/storage` explicitly and mount there instead if you'd
rather use a top-level path. Either works; just make sure the env var (if you set one) and the
volume's mount path agree. The Coolify steps below use the no-override default,
`/app/src/storage`.

## Coolify deployment

1. **Create the app.** In Coolify, add a new Application, connect this git repository, and
   explicitly select **"Dockerfile"** as the build pack (don't rely on auto-detection).
2. **Add persistent storage.** Add a persistent volume (or bind mount) for uploaded images, per
   Coolify's persistent storage docs. Mount path: `/app/src/storage` (the app's own default
   resolved against `WORKDIR /app` — see above). This is what makes uploads survive redeploys;
   without it, every deploy wipes pending/retained files.
3. **Set environment variables** in Coolify's UI, Runtime scope — see [Configuration](#configuration)
   for the full list. At minimum:
   - `PORT` — e.g. `3000` (match whatever you set as the exposed port in step 4).
   - `API_KEY` — a strong random shared secret for the `X-API-Key` header (e.g.
     `openssl rand -hex 32`). Do not ship a placeholder value — generate a real one and treat
     it as a credential.
   - `STORAGE_PATH` — only set this if you chose the `/app/storage` alternative in step 2;
     otherwise leave unset and the app's `./src/storage` default resolves correctly.
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
   independently of `/health` — see [Known limitations](#known-limitations).

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
