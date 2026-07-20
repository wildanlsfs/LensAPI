import crypto from 'node:crypto';
import fs from 'node:fs';

import { Router } from 'express';
import multer from 'multer';

import config from '../config.js';
import auth from '../middleware/auth.js';
import rateLimit from '../middleware/rateLimit.js';

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

// POST /v1/ocr — Phase 2: upload, validate, store. OCR call itself (Phase 3)
// is stubbed with placeholder/null fields for now.
router.post('/', auth, rateLimit, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'invalid_file',
      message: 'Missing or invalid image file. Expected field "image" with mimetype image/jpeg, image/png, or image/webp.',
    });
  }

  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + config.RETENTION_DAYS * 24 * 60 * 60 * 1000);

  res.status(200).json({
    id: req.file.filename,
    language: null,
    text: null,
    segments: [],
    links: { detected: [], search: null },
    expiresAt: expiresAt.toISOString(),
  });
});

export default router;
