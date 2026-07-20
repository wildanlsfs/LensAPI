// URL-detection + search-link generation from OCR text, per PRD §3.2.
//
// Matches http(s):// URLs and bare www.-prefixed tokens (a common OCR case
// where images show "www.example.com" without a scheme). Stops at
// whitespace or common trailing punctuation/closing brackets that are more
// likely to be sentence punctuation than part of the URL.
const URL_REGEX = /\b((?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+)/gi;

function stripTrailingPunctuation(url) {
  return url.replace(/[.,;:!?]+$/, '');
}

// detected: URL-shaped substrings found verbatim in the text, each wrapped
// as { type: "detected", url }.
function detectUrls(text) {
  if (!text) return [];

  const matches = text.match(URL_REGEX) || [];

  return matches
    .map(stripTrailingPunctuation)
    .filter(Boolean)
    .map((url) => ({ type: 'detected', url }));
}

// search: one convenience google.com/search?q=<encoded text> link, or null
// if there's no non-whitespace text to search for.
function buildSearchLink(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  return {
    type: 'search',
    url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`,
  };
}

// Returns { detected: [...], search: {...} | null } per PRD §3.2's `links`
// shape.
export function extractLinks(text) {
  return {
    detected: detectUrls(text),
    search: buildSearchLink(text),
  };
}

export default { extractLinks };
