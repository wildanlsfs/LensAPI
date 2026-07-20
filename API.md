# LensAPI — API Reference

Base URL: `https://<your-lensapi-domain>` (or `http://localhost:$PORT` locally, default port `3000`).

All responses are `application/json`. All endpoints are read this doc top to bottom for the
full contract; for a narrative "how do I integrate this into my chat app" walkthrough see
[README.md § Chat app integration](./README.md#chat-app-integration).

## Authentication

`POST /v1/ocr` requires an `X-API-Key` header matching the server's `API_KEY` environment
variable. This is a single shared service-to-service secret, not per-user auth — call this API
from your chat app's backend, never directly from an end-user client, so the key never leaks.

```
X-API-Key: <shared secret>
```

`GET /health` and `GET /health/lens` do **not** require authentication (they're meant for
uptime probes / Coolify health checks).

---

## `POST /v1/ocr`

Upload an image and run it through OCR. Returns extracted text, per-line bounding boxes, and
convenience links.

### Request

| | |
|---|---|
| Method | `POST` |
| Path | `/v1/ocr` |
| Content-Type | `multipart/form-data` |
| Auth | Required (`X-API-Key`) |
| Rate limit | 20 requests / 15 minutes per source IP |

**Form fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | file | yes | One of `image/jpeg`, `image/png`, `image/webp`. Max size = `MAX_FILE_SIZE_MB` (default 10 MB). |

**Example**

```bash
curl -X POST https://lensapi.example.com/v1/ocr \
  -H "X-API-Key: $LENSAPI_KEY" \
  -F "image=@photo.jpg"
```

### Response — `200 OK`

```json
{
  "id": "1784512465208-073e4425-d1a3-418d-adc3-0804c9eb0811",
  "language": "en",
  "text": "Hello World\nVisit https://example.com/page",
  "segments": [
    {
      "text": "Hello World",
      "boundingBox": {
        "centerPerX": 0.5,
        "centerPerY": 0.2,
        "perWidth": 0.4,
        "perHeight": 0.1,
        "pixelCoords": { "x": 60, "y": 12, "width": 120, "height": 24 }
      }
    },
    {
      "text": "Visit https://example.com/page",
      "boundingBox": { "...": "..." }
    }
  ],
  "links": {
    "detected": [
      { "type": "detected", "url": "https://example.com/page" }
    ],
    "search": {
      "type": "search",
      "url": "https://www.google.com/search?q=Hello%20World%0AVisit%20https%3A%2F%2Fexample.com%2Fpage"
    }
  },
  "expiresAt": "2026-07-27T01:54:25.213Z"
}
```

**Field reference**

| Field | Type | Description |
|---|---|---|
| `id` | string | Generated file identifier (also the stored filename). There is **no** endpoint to fetch the image back by this id — see "Storage & expiry" below. |
| `language` | string \| null | Best-guess language code detected by Lens (e.g. `"en"`). `null` if undetermined. |
| `text` | string | All detected text segments joined with `\n`, in the order Lens returned them. Safe default for display. |
| `segments` | array | Per-line OCR results, each with `text` and a `boundingBox` (percentage-of-image coordinates in `centerPerX`/`centerPerY`/`perWidth`/`perHeight`, plus absolute `pixelCoords`). Use this only if you need to overlay/highlight text on the original image; otherwise ignore and just use `text`. |
| `links.detected` | array | URL-shaped substrings found verbatim inside `text` (e.g. a photographed business card or poster). Each entry: `{ "type": "detected", "url": "..." }`. |
| `links.search` | object \| null | A single `google.com/search?q=...` convenience link built from `text`. **Not** a Google Lens visual/reverse-image search — just a plain text search link. `null` if `text` is empty. |
| `expiresAt` | string (ISO-8601) | When the uploaded image will be deleted from server storage (`uploadedAt + RETENTION_DAYS`, default 7 days). |

### Error responses

Every error is a flat shape:

```json
{ "error": "<error_code>", "message": "<human-readable message>" }
```

Branch your client logic on the `error` field, not just the HTTP status — several error codes
share a status.

| HTTP status | `error` | Cause | Suggested client handling |
|---|---|---|---|
| `400` | `invalid_file` | Missing `image` field, or file isn't JPEG/PNG/WebP | Show "unsupported image format" |
| `400` | `file_too_large` | Upload exceeds `MAX_FILE_SIZE_MB` | Show "image too large"; consider resizing client-side before upload |
| `400` | `upload_error` | Other multipart/form parsing failure | Generic "upload failed, try again" |
| `401` | `unauthorized` | Missing or incorrect `X-API-Key` | Should never reach real end users — indicates a backend misconfiguration; log and alert |
| `429` | `rate_limited` | Too many requests from this IP in the current 15-minute window | Retry with backoff |
| `502` | `lens_upstream_error` | Google's Lens endpoint failed, changed, or blocked the request — **not a bug in this service** | Show "couldn't read text from that image right now, try again shortly"; avoid tight-loop retries |
| `500` | `internal_error` | Unexpected server-side failure | Generic "something went wrong"; log for investigation |

### Storage & expiry

The uploaded image is written to server-side disk storage and deleted automatically after
`RETENTION_DAYS` (default 7). There is no `GET /v1/ocr/:id` or any other endpoint to retrieve
the original image later — `id` is returned only for your own logging/correlation. If your
application needs to keep showing the source image beyond that window, store your own copy.

---

## `GET /health`

Liveness check — confirms the process is running. Does **not** call out to Google.

```bash
curl https://lensapi.example.com/health
```

**Response — `200 OK`**
```json
{ "status": "ok" }
```

This is the endpoint Coolify (or any uptime monitor) should probe for basic liveness.

---

## `GET /health/lens`

Deep health check — actually exercises `chrome-lens-ocr` against a small bundled test image, so
you can detect "Google's Lens endpoint itself is unreachable/blocked" as a condition distinct
from "the service process is down." See [PRD.md § 2](./PRD.md) for why this matters: LensAPI
wraps an unofficial, reverse-engineered endpoint that Google can change or block without notice.

```bash
curl https://lensapi.example.com/health/lens
```

**Response — `200 OK`** (Lens call succeeded)
```json
{ "status": "ok" }
```

**Response — `503 Service Unavailable`** (Lens call failed)
```json
{ "status": "error", "message": "Google Lens OCR service is unreachable or returned an error." }
```

Monitor this separately from `/health`. If `/health` stays green while `/health/lens` starts
failing, that's an upstream Google issue — redeploying or restarting LensAPI will not fix it.

---

## Summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/ocr` | `X-API-Key` | Upload an image, get back OCR text/segments/links |
| `GET /health` | none | Process liveness (Coolify probe target) |
| `GET /health/lens` | none | Upstream Google Lens availability |
