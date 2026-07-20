// Central Express error handler — implemented in Phase 2 (Multer errors) and
// Phase 3 (Lens upstream errors).
// eslint-disable-next-line no-unused-vars
export default function errorHandler(err, req, res, next) {
  res.status(500).json({ error: 'internal_error', message: err.message });
}
