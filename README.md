# LensAPI

Self-hosted, unofficial Google Lens OCR API. A chat app calls this service over HTTP so users
can extract text from images (JPEG/PNG/WebP) without leaving the chat app — upload an image,
get back the OCR'd text, per-segment bounding boxes, and a couple of convenience links. It's
deployed as a standalone Docker service on Coolify, backed by
[`chrome-lens-ocr`](https://github.com/dimdenGD/chrome-lens-ocr), a reverse-engineered client
for Google Lens's internal OCR endpoint (see [PRD.md](./PRD.md) §2 for the caveats that come
with that).

Full functional/non-functional spec: [PRD.md](./PRD.md). Phased build history:
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Local development

```bash
npm install
cp .env.example .env   # then fill in API_KEY at minimum
npm start               # or: npm run dev (nodemon)
```

The server binds `0.0.0.0:$PORT` (default `3000`). Confirm it's up:

```bash
curl localhost:3000/health
```

## API overview

- `POST /v1/ocr` — multipart/form-data upload, field name `image` (JPEG/PNG/WebP, max
  `MAX_FILE_SIZE_MB`). Requires an `X-API-Key` header matching the server's `API_KEY`. Returns
  OCR text, segments with bounding boxes, and detected/search links.
- `GET /health` — liveness only (process up). This is what Coolify's health check probes.
- `GET /health/lens` — deeper check that exercises `chrome-lens-ocr` against a bundled test
  image, so you can tell "the service is up but Google Lens itself is unreachable/blocked"
  apart from plain process liveness.

The full request/response contract (exact JSON shapes, error codes, example curl calls) is
documented in [PRD.md](./PRD.md) §3.1–3.2 and will get a dedicated chat-app integration
write-up in a later phase — this section is just enough to orient a new reader.

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
volume's mount path agree. This README's Coolify steps below use the no-override default,
`/app/src/storage`.

## Coolify deployment

1. **Create the app.** In Coolify, add a new Application, connect this git repository, and
   explicitly select **"Dockerfile"** as the build pack (don't rely on auto-detection).
2. **Add persistent storage.** Add a persistent volume (or bind mount) for uploaded images, per
   Coolify's persistent storage docs. Mount path: `/app/src/storage` (the app's own default
   resolved against `WORKDIR /app` — see above). This is what makes uploads survive redeploys;
   without it, every deploy wipes pending/retained files.
3. **Set environment variables** in Coolify's UI, Runtime scope:
   - `PORT` — e.g. `3000` (match whatever you set as the exposed port in step 4).
   - `API_KEY` — a strong random shared secret for the `X-API-Key` header (e.g.
     `openssl rand -hex 32`). Do not ship a placeholder value — generate a real one and treat
     it as a credential.
   - `STORAGE_PATH` — only set this if you chose the `/app/storage` alternative in step 2;
     otherwise leave unset and the app's `./src/storage` default resolves correctly.
   - `RETENTION_DAYS` — e.g. `7`.
   - `MAX_FILE_SIZE_MB` — e.g. `10`.
   - `LENS_COOKIE` / `LENS_PROXY_URL` — optional, only needed if Google starts
     blocking/rate-limiting the server's IP (PRD §4).
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
   independently of `/health` — see "Known limitations" below.

## Known limitations

This service depends on an **unofficial, reverse-engineered** Google Lens endpoint (via
`chrome-lens-ocr` — see [PRD.md](./PRD.md) §2), not a supported Google API. Google can change
or block it without notice, and upstream has recurring reports of intermittent non-200/303
errors. `GET /health/lens` exists specifically so you can detect "Lens itself is broken/blocked"
as a distinct condition from "the service process is down" — monitor it separately from
`/health` if you want early warning of upstream breakage.
