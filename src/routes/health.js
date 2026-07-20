import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import { scanImage } from '../services/lens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Small bundled fixture (committed to git, not gitignored/user-upload
// storage) used purely to exercise the chrome-lens-ocr call path. It does
// not need to contain readable text — /health/lens only checks that the
// call to Google's Lens endpoint succeeds, not what it returns.
const HEALTH_CHECK_IMAGE_PATH = path.join(__dirname, '../fixtures/health-check.jpg');

const router = Router();

// GET /health — liveness only (process up).
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// GET /health/lens — deeper check that exercises chrome-lens-ocr against a
// tiny known test image, per PRD §3.6, to detect upstream breakage (Google
// blocking/changing the reverse-engineered endpoint, PRD §2) separately from
// plain process liveness.
router.get('/lens', async (req, res) => {
  try {
    const buffer = await fs.promises.readFile(HEALTH_CHECK_IMAGE_PATH);
    await scanImage(buffer);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Lens health check failed:', err);
    res.status(503).json({
      status: 'error',
      message: 'Google Lens OCR service is unreachable or returned an error.',
    });
  }
});

export default router;
