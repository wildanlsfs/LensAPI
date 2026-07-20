import config from '../config.js';

// X-API-Key auth middleware.
//
// Design choice: even if config.API_KEY is unset/empty (e.g. local dev without a
// .env value), we still require the caller to send a matching X-API-Key header
// rather than silently disabling auth. The PRD (§3.4) frames this endpoint as
// public-facing on Coolify and expects a shared service key to always be
// enforced, so "open when unset" would be an easy way to accidentally ship an
// unauthenticated endpoint to production if API_KEY is ever missing from the
// deployed env. For local dev/testing, just set API_KEY in your .env.
export default function auth(req, res, next) {
  const providedKey = req.get('X-API-Key');

  if (!providedKey || !config.API_KEY || providedKey !== config.API_KEY) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid X-API-Key header.',
    });
  }

  next();
}
