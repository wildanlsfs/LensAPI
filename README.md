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
documented in [PRD.md](./PRD.md) §3.1–3.2. See "Chat app integration" below for exactly what
your chat app backend needs to send and handle.

## Chat app integration

This is what the chat app backend needs to know to call LensAPI. LensAPI has no concept of
your app's users or sessions — it's a stateless, service-to-service OCR call gated by a single
shared `API_KEY`. Your chat app backend should call it server-side (not directly from the
client), so the API key never reaches end users.

### Request

```
POST https://<your-lensapi-domain>/v1/ocr
Content-Type: multipart/form-data
X-API-Key: <shared secret, same value as LensAPI's API_KEY env var>

image=<binary file, field name "image", JPEG/PNG/WebP, up to MAX_FILE_SIZE_MB>
```

Example:

```bash
curl -X POST https://lensapi.example.com/v1/ocr \
  -H "X-API-Key: $LENSAPI_KEY" \
  -F "image=@photo.jpg"
```

### Success response — `200`

```json
{
  "id": "1784512465208-073e4425-d1a3-418d-adc3-0804c9eb0811",
  "language": "en",
  "text": "Hello World\nVisit https://example.com/page",
  "segments": [
    {
      "text": "Hello World",
      "boundingBox": {
        "centerPerX": 0.5, "centerPerY": 0.2, "perWidth": 0.4, "perHeight": 0.1,
        "pixelCoords": { "x": 60, "y": 12, "width": 120, "height": 24 }
      }
    }
  ],
  "links": {
    "detected": [{ "type": "detected", "url": "https://example.com/page" }],
    "search": { "type": "search", "url": "https://www.google.com/search?q=Hello%20World..." }
  },
  "expiresAt": "2026-07-27T01:54:25.213Z"
}
```

Rendering guidance:
- `text` — the safest default: show it as OCR'd text, e.g. in a reply bubble.
- `segments[].boundingBox` — only useful if you want to overlay text on the original image
  (e.g. highlight regions); most chat UIs can ignore this and just use `text`.
- `links.detected` — real URLs found in the image text (e.g. a photographed business card or
  poster). Consider rendering these as tappable link chips.
- `links.search` — a "search this text on Google" convenience link, not a Google Lens visual
  search. Present it as a secondary action, not the primary result.
- `id` / `expiresAt` — **the uploaded image itself is deleted from LensAPI's storage after
  `expiresAt` (7 days by default).** LensAPI does not expose a way to re-fetch the original
  image by `id` at all — there is no `GET /v1/ocr/:id` endpoint. If your chat app needs to keep
  showing the source image long after upload, store your own copy; don't rely on LensAPI as
  image storage.

### Error responses

| Status | Body shape | Meaning | Suggested handling |
|---|---|---|---|
| `400` | `{ "error": "invalid_file", "message": "..." }` | Missing file, or wrong mimetype (not JPEG/PNG/WebP) | Surface a "unsupported image format" message to the user |
| `400` | `{ "error": "file_too_large", "message": "..." }` | Upload exceeds `MAX_FILE_SIZE_MB` | Surface a "image too large" message; consider client-side resizing before upload |
| `400` | `{ "error": "upload_error", "message": "..." }` | Other multipart/Multer validation failure | Generic "upload failed, try again" |
| `401` | `{ "error": "unauthorized", "message": "..." }` | Missing/wrong `X-API-Key` | Backend config bug — should never reach real users; log and alert, don't surface raw to end users |
| `429` | `{ "error": "rate_limited", "message": "..." }` | Too many requests from this backend's IP in the current window | Retry with backoff; if this happens routinely in prod, the rate limit constant in LensAPI may need raising |
| `502` | `{ "error": "lens_upstream_error", "message": "..." }` | Google's Lens endpoint failed/changed/blocked the request — **this is the one failure mode that isn't really "your" bug** | Surface a friendly "couldn't read text from that image right now, try again shortly" — don't retry immediately in a tight loop, since a 502 here often means Google is rate-limiting or has changed the endpoint (see "Known limitations") |
| `500` | `{ "error": "internal_error", "message": "..." }` | Unexpected server-side failure, not one of the above | Generic "something went wrong" + log for investigation |

Every error response is a flat `{ "error": "<code>", "message": "<human-readable>" }` shape,
so a single client-side switch on `error` (not on HTTP status alone) is enough to branch UI
behavior — HTTP status tells you the category, `error` tells you the specific case.

### Operational notes for the chat app team

- Treat `/health/lens` (see above) as a separate signal from `/health` when monitoring —
  if it starts failing while `/health` stays green, that's Google's endpoint breaking, not a
  LensAPI outage, and no amount of retrying/redeploying LensAPI will fix it (see
  [PRD.md](./PRD.md) §2).
- There's no per-end-user auth or usage tracking in LensAPI itself — if you need per-user rate
  limits, quotas, or abuse prevention beyond the blanket IP-based limit, enforce that in your
  chat app backend before calling LensAPI, not after.

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
