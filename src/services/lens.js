import Lens, { LensError } from 'chrome-lens-ocr';
import { ProxyAgent } from 'undici';

import config from '../config.js';

// Re-export so callers (route handlers) can classify Lens-specific failures
// without importing chrome-lens-ocr directly.
export { LensError };

// Build the options object passed to `new Lens(options)`. Per the installed
// chrome-lens-ocr v4.1.1 source (node_modules/chrome-lens-ocr/src/core.js,
// src/index.js), the constructor accepts: chromeVersion, userAgent, headers
// (headers.cookie may be a string or object), fetchOptions (e.g. dispatcher
// for a proxy agent), targetLanguage, viewport. We only set what PRD/config
// expose: headers.cookie from LENS_COOKIE, fetchOptions.dispatcher from a
// ProxyAgent built with LENS_PROXY_URL.
function buildLensOptions() {
  const options = {};

  if (config.LENS_COOKIE) {
    options.headers = { cookie: config.LENS_COOKIE };
  }

  if (config.LENS_PROXY_URL) {
    options.fetchOptions = { dispatcher: new ProxyAgent(config.LENS_PROXY_URL) };
  }

  return options;
}

// Module-level singleton — instantiated once at process start, not per
// request (per Phase 3 plan; avoids re-parsing cookies/config on every
// upload and lets the instance accumulate/reuse Google's session cookies
// across requests, which chrome-lens-ocr supports via `lens.cookies`).
const lens = new Lens(buildLensOptions());

// Calls chrome-lens-ocr's scanByBuffer(buffer): Promise<LensResult>, where
// LensResult = { language: String, segments: [{ text, boundingBox }] }.
// Errors (including LensError, thrown on non-2xx upstream responses) are
// intentionally NOT caught here — they propagate to the caller so the route
// handler / error middleware can classify and respond distinctly (PRD §3.2
// lens_upstream_error / 502) instead of this service silently swallowing or
// reshaping failures.
export async function scanImage(buffer) {
  return lens.scanByBuffer(buffer);
}

export default { scanImage };
