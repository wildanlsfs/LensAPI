import multer from 'multer';

import { LensUpstreamError } from '../errors/LensUpstreamError.js';

// Central Express error handler — implemented in Phase 2 (Multer errors) and
// Phase 3 (Lens upstream errors).
//
// Standard Express 4-arg error-handling middleware signature. This is
// unaffected by the Express 4 -> 5 upgrade; error-middleware conventions
// (arity-based detection, next(err) propagation) are unchanged in Express 5.
// eslint-disable-next-line no-unused-vars
export default function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Uploaded file exceeds the maximum allowed size.',
      });
    }

    return res.status(400).json({
      error: 'upload_error',
      message: err.message,
    });
  }

  if (err instanceof LensUpstreamError) {
    // Reverse-engineered upstream (PRD §2 "known fragility") — surface a
    // distinct, non-500 error so callers (chat app / ops) can tell "Lens is
    // down" apart from "our service is broken". Log full detail (including
    // the wrapped cause) server-side; never leak internals to the client.
    console.error('Lens upstream error:', err.cause || err);

    return res.status(502).json({
      error: 'lens_upstream_error',
      message: 'Google Lens OCR service returned an error.',
    });
  }

  // Unknown error — log server-side with full detail, but never leak stack
  // traces or internals in the JSON response body.
  console.error(err);

  res.status(500).json({
    error: 'internal_error',
    message: 'An unexpected error occurred.',
  });
}
