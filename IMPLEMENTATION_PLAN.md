# LensAPI — Implementation Plan

Spec: see [PRD.md](./PRD.md). This plan executes it in phases, each independently
verifiable and resumable in a fresh session.

## Phase 0 — Documentation findings (reference, already gathered)

**chrome-lens-ocr** (github.com/dimdenGD/chrome-lens-ocr, v4.1.1):
- `new Lens(options?)` — options: `chromeVersion`, `userAgent`, `headers` (incl. `cookie`),
  `fetchOptions` (incl. `dispatcher` for `undici.ProxyAgent`).
- `lens.scanByBuffer(buffer: Buffer): Promise<{ language, segments: [{ text, boundingBox }] }>`
- No reverse-image-search data anywhere in the response — OCR only.
- Depends on `sharp` (native, prebuilt binaries for glibc + musl — no compile needed if
  correct binary installed).

**Multer** (github.com/expressjs/multer, v2.2.0):
```js
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_PATH),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(null, ok);
  }
});
```
Error handling: mount via manual callback form or standard Express 4-arg error middleware;
check `err instanceof multer.MulterError` and `err.code === 'LIMIT_FILE_SIZE'`.

**node-cron** (v4.6.0): `cron.schedule('0 3 * * *', callback)` — 5-field standard cron,
callback runs daily at 03:00 server time.

**Coolify** (coolify.io/docs):
- Build pack: select "Dockerfile" explicitly in app config (not silent auto-detection).
- Persistent storage: named volume or bind mount configured in the Coolify UI, survives
  redeploys — mount at `STORAGE_PATH` (e.g. `/app/storage`).
- Env vars: UI-based (form or `.env`-paste "Developer View"), flag Runtime vs Build.
- `node:20-bookworm-slim` avoids musl/Alpine sharp edge cases; use it as base image.
- Health check: Dockerfile `HEALTHCHECK` takes precedence over UI config if both set; app
  must bind `0.0.0.0`; first exposed port is the default probed port.

**Anti-patterns to avoid:**
- Do NOT invent a `chrome-lens-ocr` reverse-image-search method — it doesn't exist.
- Do NOT use Alpine without explicitly testing `sharp`'s musl binary install — default to
  `bookworm-slim`.
- Do NOT wrap multer in try/catch (it's callback-based, not throw-based in the disk storage
  path) — use the documented callback or 4-arg Express error handler pattern.
- Do NOT add query-param response-mode switching — one consistent JSON contract (PRD 3.2).

---

## Phase 1 — Project scaffolding

**Goal:** runnable Express skeleton, no OCR yet.

- `git init` in `/Applications/XAMPP/xamppfiles/htdocs/LensAPI`
- `npm init`, install: `express`, `multer`, `chrome-lens-ocr`, `node-cron`,
  `express-rate-limit`, `dotenv`, `helmet`, `cors`
- Dev deps: `nodemon` (optional)
- Structure:
  ```
  src/
    index.js          # app entrypoint
    config.js          # env var loading + defaults
    middleware/
      auth.js           # X-API-Key check
      rateLimit.js
      errorHandler.js
    routes/
      ocr.js
      health.js
    services/
      lens.js           # wraps chrome-lens-ocr calls
      cleanup.js         # node-cron job
      links.js           # URL-detection + search-link generation
    storage/            # STORAGE_PATH default target (gitignored)
  .env.example
  .gitignore            # node_modules, .env, storage/
  Dockerfile
  README.md
  ```
- `.env.example` listing every var from PRD §4.
- `GET /health` returns `{ status: "ok" }`.

**Verify:** `npm start` boots, `curl localhost:PORT/health` returns 200.

## Phase 2 — Upload endpoint + storage

**Goal:** `POST /v1/ocr` accepts a file, validates it, stores it, returns a stub response
(no OCR call yet).

- Implement `multer` disk storage per Phase 0 snippet, wired to `STORAGE_PATH` from config.
- `fileFilter` restricts to jpeg/png/webp; `limits.fileSize` from `MAX_FILE_SIZE_MB`.
- Error handler distinguishes `MulterError` (400, specific code/message) from other errors.
- API key middleware (`X-API-Key` header vs `API_KEY` env) applied to `/v1/ocr`.
- Rate limiting middleware applied globally or to `/v1/ocr`.
- Response stub includes `id`, `expiresAt` (uploadedAt + `RETENTION_DAYS`), placeholder
  `text`/`segments`/`links`.

**Verify:**
- `curl -F image=@test.jpg -H "X-API-Key: ..." localhost:PORT/v1/ocr` → 200, file appears
  in `STORAGE_PATH`.
- Oversized file → 400 with `LIMIT_FILE_SIZE` code.
- Wrong mimetype (e.g. `.pdf`) → 400.
- Missing/wrong API key → 401.
- No API key header at all on a request without rate-limit issues → still 401 (auth checked
  before rate limit doesn't leak whether key format matters).

## Phase 3 — OCR integration

**Goal:** wire `chrome-lens-ocr` into the upload flow; return the real response contract.

- `services/lens.js`: instantiate `Lens` once (module-level singleton, not per-request) with
  optional `LENS_COOKIE`/`LENS_PROXY_URL` from env passed into `headers`/`fetchOptions`.
- On upload: read the stored file into a buffer, call `lens.scanByBuffer(buffer)`.
- Map the library response into the PRD §3.2 contract: `language`, `text` (segments joined),
  `segments` (pass through), `links.detected` (regex URL extraction from `text`),
  `links.search` (`https://www.google.com/search?q=` + encoded text, only if text non-empty).
- Catch Lens errors distinctly: return `502 { error: "lens_upstream_error", message }`
  rather than a generic 500, per PRD §3.2.
- `GET /health/lens`: run `scanByBuffer` against a small bundled test image; 200 if it
  returns segments, 503 with error detail otherwise.

**Verify:**
- Real image with text → 200 with populated `text`/`segments`, plausible `links.detected`
  if the image contains a URL.
- Simulate upstream failure (e.g. temporarily point at bad proxy) → 502 with
  `lens_upstream_error`, not a stack-trace 500.
- `/health/lens` reflects real Lens availability.

## Phase 4 — Retention / cleanup job

**Goal:** files older than `RETENTION_DAYS` are deleted automatically.

- `services/cleanup.js`: `node-cron` job scheduled `0 3 * * *`, scans `STORAGE_PATH`,
  deletes files whose mtime exceeds `RETENTION_DAYS` days.
- Started once at app boot (`src/index.js`), guarded so it doesn't double-schedule under
  `nodemon` restarts in dev (not a concern in prod single-process container).
- Log each deletion (count + total for the run) for observability.

**Verify:**
- Unit-style manual test: create a file with a backdated mtime (`utimes`) beyond the
  retention window, run the cleanup function directly (export it separately from the cron
  wrapper so it's callable outside the schedule), confirm it's deleted and newer files are
  untouched.

## Phase 5 — Dockerfile + Coolify deployment

**Goal:** production-ready container, documented Coolify setup.

- Multi-stage `Dockerfile`:
  - Base: `node:20-bookworm-slim`.
  - Install prod deps only (`npm ci --omit=dev`).
  - Copy source, set `NODE_ENV=production`.
  - `EXPOSE $PORT` (document default, e.g. 3000).
  - `HEALTHCHECK` instruction hitting `GET /health` (needs `curl` installed in the image,
    or use Node's built-in `http` via a tiny script if avoiding curl).
  - `CMD ["node", "src/index.js"]`.
- `.dockerignore`: `node_modules`, `.env`, `storage/`, `.git`.
- README section: Coolify setup steps —
  1. New Application → connect repo → select "Dockerfile" build pack.
  2. Add persistent volume mounted at `STORAGE_PATH` (e.g. `/app/storage`).
  3. Set env vars (Runtime scope) for `PORT`, `API_KEY`, `STORAGE_PATH`, `RETENTION_DAYS`,
     `MAX_FILE_SIZE_MB`, optional `LENS_COOKIE`/`LENS_PROXY_URL`.
  4. Set exposed port to match `PORT`; confirm app binds `0.0.0.0`.
  5. Deploy; verify `/health` via Coolify's health-check UI or `HEALTHCHECK` in Dockerfile.

**Verify:**
- `docker build` succeeds locally; `docker run` with env vars + a mounted volume serves
  `/health` on the mapped port.
- Confirm `sharp` loads without native compile errors in the built image
  (`docker run --rm <image> node -e "require('sharp')"`).

## Phase 6 — Chat app integration contract (documentation only)

**Goal:** hand the chat app team (or your future self) exactly what's needed to integrate,
no LensAPI code changes.

- README section: example request/response, required header (`X-API-Key`), error shapes to
  handle (`400` validation, `401` auth, `502` upstream Lens failure, `503` on `/health/lens`).
- Note the 7-day expiry contract: the chat app should not assume the uploaded image URL/id
  is retrievable after `expiresAt` — if the chat app needs to redisplay the source image
  long-term, it must store its own copy, not rely on LensAPI's storage.

**Verify:** a manual end-to-end curl walkthrough matches what's documented, run once during
this phase to catch drift between code and README.

---

## Final verification checklist

- [ ] All PRD §3 functional requirements have a corresponding passing manual test above.
- [ ] `grep -r "scanByURL\|reverseImage\|visualMatch"` in `src/` returns nothing — confirms
      no invented reverse-image-search usage snuck in.
- [ ] Error responses for the three failure modes (bad upload, bad auth, upstream Lens
      failure) are distinct and documented.
- [ ] Fresh `docker build` + `docker run` end-to-end OCR request against a real image
      succeeds outside of any dev environment assumptions.
