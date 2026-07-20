# LensAPI — Product Requirements Document

## 1. Purpose

A self-hosted, unofficial Google Lens OCR API that a chat app calls over HTTP so users can
extract text from images without leaving the chat app. Deployed as a standalone Docker
service on Coolify.

**Not in scope for v1:** reverse image search / visual product matches ("search this image"
results). The underlying library (`chrome-lens-ocr`) only does OCR — text extraction with
language detection and bounding boxes. There is no visual-match data to return.

## 2. Core dependency

[`chrome-lens-ocr`](https://github.com/dimdenGD/chrome-lens-ocr) (npm: `chrome-lens-ocr`,
current v4.1.1) — a reverse-engineered client for Google Lens's internal OCR endpoint.

- No Google auth required by default.
- Methods used: `scanByBuffer(buffer)` (primary — avoids extra disk I/O since we already
  have the uploaded file in memory/on disk) and optionally `scanByFile(path)`.
- Response shape:
  ```js
  {
    language: String,
    segments: [
      {
        text: String,
        boundingBox: {
          centerPerX, centerPerY, perWidth, perHeight, // % of image
          pixelCoords: { x, y, width, height }
        }
      }
    ]
  }
  ```
- **Known fragility**: this is a reverse-engineered endpoint, not an official API. Google can
  change or block it without notice (see upstream issues #26, #29, #35 — recurring
  "non-200"/303 errors). Design implication: errors from the OCR call must be caught and
  surfaced as a distinct, clearly-labeled error (not a generic 500), and a `/health` endpoint
  should do a lightweight self-test so the chat app / ops can detect when Lens itself is down
  vs. our service being down.
- Native dependency risk: `chrome-lens-ocr` depends on `sharp`, which ships prebuilt binaries
  for both glibc (Debian) and musl (Alpine) — no compilation needed if the correct binary is
  installed for the target platform/libc.

## 3. Functional requirements

### 3.1 Upload + OCR endpoint
- `POST /v1/ocr` — multipart/form-data, field name `image`.
- Accepts JPEG, PNG, WebP. Reject anything else with `400`.
- Max file size: configurable, default 10 MB.
- Saves the file to a local persistent volume (`STORAGE_PATH`, e.g. `/app/storage`) using a
  generated unique filename (not the original name).
- Runs the file through `chrome-lens-ocr`.
- Returns a single consistent JSON contract (see 3.2) regardless of content — the client
  decides how to render it (text bubble, link chip, etc.). No query-param response-mode
  switching.

### 3.2 Response contract
```json
{
  "id": "generated-file-id",
  "language": "en",
  "text": "full concatenated OCR text",
  "segments": [
    { "text": "...", "boundingBox": { "...": "..." } }
  ],
  "links": [
    { "type": "detected", "url": "https://..." },
    { "type": "search", "url": "https://www.google.com/search?q=..." }
  ],
  "expiresAt": "ISO-8601 timestamp, uploadedAt + 7 days"
}
```
- `links.detected`: any URL-shaped substrings found in the OCR text, surfaced verbatim.
- `links.search`: one generated `google.com/search?q=<encoded text>` convenience link built
  from the extracted text (not a Google Lens visual search — just a text search link).
- On upstream Lens failure: return a distinct error shape, e.g.
  `{ "error": "lens_upstream_error", "message": "..." }` with `502`, so the chat app can
  distinguish "Lens is down" from "your request was bad."

### 3.3 File retention
- Uploaded images are stored for 7 days (`RETENTION_DAYS`, default 7), then deleted.
- A scheduled daily job (`node-cron`, `0 3 * * *`) scans the storage directory and removes
  files older than the retention window.
- Retention applies to the uploaded image only; OCR results are not persisted server-side
  beyond the request/response (chat app is responsible for storing what it needs).

### 3.4 Auth
- Since this is a public-facing endpoint on Coolify, require a static API key
  (`X-API-Key` header) shared with the chat app backend, checked via middleware.
  Configurable via env var (`API_KEY`). Not full OAuth/user-level auth — this is a
  service-to-service key between the chat app backend and LensAPI.

### 3.5 Rate limiting
- Basic IP-based rate limiting (e.g. `express-rate-limit`) to protect against abuse and to
  reduce the chance of Google rate-limiting/blocking the server's IP due to burst traffic.

### 3.6 Health check
- `GET /health` — liveness only (process up), for Coolify's health-check probe (binds
  `0.0.0.0`, first exposed port is what Coolify probes by default).
- `GET /health/lens` — optional deeper check that exercises `chrome-lens-ocr` against a tiny
  known test image, to detect upstream breakage separately from process liveness.

## 4. Non-functional requirements

- **Deployment**: Docker image deployed via Coolify's "Dockerfile" build pack. Base image
  `node:20-bookworm-slim` (glibc) to avoid Alpine/musl sharp edge cases.
- **Storage**: Coolify persistent volume mounted at `STORAGE_PATH` (survives redeploys).
- **Config** (env vars): `PORT`, `API_KEY`, `STORAGE_PATH`, `RETENTION_DAYS`, `MAX_FILE_SIZE_MB`,
  optional `LENS_COOKIE` / `LENS_PROXY_URL` (passed through to `chrome-lens-ocr`'s
  `headers.cookie` / `fetchOptions.dispatcher` options if Google starts blocking the server IP).
- **Observability**: structured request logging; clear error codes so failures are triaged
  fast (bad upload vs. upstream Lens failure vs. internal error).

## 5. Explicit non-goals (v1)

- No reverse image search / visual product matches.
- No S3/object storage — local volume only.
- No per-end-user auth — single shared service API key for the chat app backend.
- No translation features (upstream library has no translation support yet — open issue #25).
