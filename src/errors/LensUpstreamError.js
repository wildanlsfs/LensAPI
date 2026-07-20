// Wrapper error used to tag any failure that occurred while calling out to
// chrome-lens-ocr (network failure, non-2xx response via LensError, proto
// parse failure, etc.) so errorHandler.js can distinguish "Lens upstream
// failed" (-> 502 lens_upstream_error, PRD §3.2) from other errors (-> 500).
//
// We wrap rather than rely solely on `instanceof LensError` because
// chrome-lens-ocr can also throw plain Errors (e.g. sharp metadata failures,
// missing image dimensions) that are still upstream-OCR-call failures from
// this service's point of view and should be reported the same way.
export class LensUpstreamError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'LensUpstreamError';
    if (cause !== undefined) this.cause = cause;
  }
}

export default LensUpstreamError;
