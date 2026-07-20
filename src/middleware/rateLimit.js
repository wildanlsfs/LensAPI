import rateLimit from 'express-rate-limit';

// IP-based rate limiting (PRD §3.5) — protects against abuse and reduces the
// chance of Google rate-limiting/blocking this server's IP due to burst
// traffic against the Lens upstream.
//
// Reasonable default for an image-upload API: 20 requests per 15-minute
// window per IP. Not exposed as an env var — the PRD's config list (§4)
// doesn't include rate-limit tuning, so keep it a constant here.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 20;

export default rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    message: 'Too many requests. Please try again later.',
  },
});
