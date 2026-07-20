import crypto from 'node:crypto';
import fs from 'node:fs';

import { Router } from 'express';
import multer from 'multer';

import config from '../config.js';
import auth from '../middleware/auth.js';
import rateLimit from '../middleware/rateLimit.js';
import { scanImage } from '../services/lens.js';
import { extractLinks } from '../services/links.js';
import { LensUpstreamError } from '../errors/LensUpstreamError.js';

// Ensure the upload destination exists before multer ever tries to write to
// it (multer does not create missing directories itself).
fs.mkdirSync(config.STORAGE_PATH, { recursive: true });

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Multer disk storage per the Phase 0 documented pattern: generated unique
// filename, never the original (untrusted) filename, to avoid path traversal
// / collision issues.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.STORAGE_PATH),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIME_TYPES.includes(file.mimetype);
    // Per multer's documented fileFilter contract: cb(null, false) silently
    // skips the file (no error thrown here) — req.file will simply be
    // undefined afterward, which the route handler below checks explicitly.
    cb(null, ok);
  },
});

const router = Router();

// POST /v1/ocr — upload, validate, store, then run the stored file through
// chrome-lens-ocr and return the PRD §3.2 response contract.
router.post('/', auth, rateLimit, upload.single('image'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'invalid_file',
      message: 'Missing or invalid image file. Expected field "image" with mimetype image/jpeg, image/png, or image/webp.',
    });
  }

  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + config.RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let ocrResult;
  try {
    const buffer = await fs.promises.readFile(req.file.path);
    ocrResult = await scanImage(buffer);
  } catch (err) {
    // Tag as a distinct upstream-Lens failure so errorHandler.js can respond
    // 502 lens_upstream_error instead of a generic 500 (PRD §3.2 / §2).
    return next(new LensUpstreamError('chrome-lens-ocr scan failed', { cause: err }));
  }

  // segments[].text joined with newlines: each segment is a detected line,
  // so newline-joining preserves the original line structure better than
  // spaces would (e.g. multi-line signage/screenshots stay readable).
  const text = (ocrResult.segments || []).map((segment) => segment.text).join('\n');

  res.status(200).json({
    id: req.file.filename,
    language: ocrResult.language ?? null,
    text,
    segments: ocrResult.segments || [],
    links: extractLinks(text),
    expiresAt: expiresAt.toISOString(),
  });
});

export default router;
