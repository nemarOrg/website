/**
 * JSON preview renderer. Pretty-prints input as a syntax-colored `<pre>`
 * for the inline file viewer. Returns the full HTML body for a
 * `.tree__preview` slot.
 *
 * Flat indented view, not a collapsible tree. The architect's rationale
 * (#85): BIDS sidecar JSONs are flat-or-one-level-deep, the user scans
 * "what keys exist + their values" top-to-bottom. A tree adds recursive
 * click handlers + a bunch of extra DOM for files where the natural
 * reading order is linear. Four token spans (key, string, number,
 * keyword) give the visual distinction without parser machinery.
 *
 * Malformed JSON falls back to a verbatim `<pre>` so the user can still
 * read the bytes; a small banner names the parse error.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Single-pass tokenizer that walks the escaped, pretty-printed JSON output
 *  of `JSON.stringify(_, null, 2)` and wraps tokens in syntax-color spans.
 *  Operates on already-HTML-escaped text, so the regex patterns reference
 *  `&quot;` rather than `"` and never need to handle raw `<`.
 *
 *  Why a tokenizer and not chained regex `.replace()` passes: the simple
 *  approach (replace keys, then replace remaining strings) double-wraps
 *  strings inside already-wrapped keys, because the second pass re-matches
 *  the inner content of the first pass's wrapper. One pass keeps the
 *  invariant that every position is visited once.
 */
function colorizeJson(formatted: string): string {
  let out = "";
  let i = 0;
  const n = formatted.length;
  while (i < n) {
    // Quoted string: open at &quot;, walk until closing &quot;. Escaped
    // quotes inside a string come through as `\&quot;` (the backslash
    // survived esc()), so check for that and skip past.
    if (formatted.startsWith("&quot;", i)) {
      const start = i;
      i += 6;
      while (i < n && !formatted.startsWith("&quot;", i)) {
        if (formatted[i] === "\\" && formatted.startsWith("&quot;", i + 1)) {
          i += 7;
          continue;
        }
        i++;
      }
      if (i < n) i += 6;
      const literal = formatted.slice(start, i);
      // Key vs string: a key is followed by an optional run of spaces and
      // a colon. Anything else (closing brace, comma, end-of-input) makes
      // this a value-position string.
      let j = i;
      while (j < n && formatted[j] === " ") j++;
      const isKey = formatted[j] === ":";
      out += isKey
        ? `<span class="json-key">${literal}</span>`
        : `<span class="json-str">${literal}</span>`;
      continue;
    }
    // Number: only at the start of a value position (after `:`, `,`, `[`,
    // or whitespace including a newline) so a digit inside an identifier
    // never matches. JSON allows optional leading minus + integer +
    // optional fraction + optional exponent.
    const prevChar = i > 0 ? formatted[i - 1] : "\n";
    if (/[-\d]/.test(formatted[i]) && /[\s:,[]/.test(prevChar)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(formatted.slice(i));
      if (m) {
        out += `<span class="json-num">${m[0]}</span>`;
        i += m[0].length;
        continue;
      }
    }
    // Keyword: true, false, null in value position.
    if (/[tfn]/.test(formatted[i]) && /[\s:,[]/.test(prevChar)) {
      const m = /^(true|false|null)\b/.exec(formatted.slice(i));
      if (m) {
        out += `<span class="json-kw">${m[0]}</span>`;
        i += m[0].length;
        continue;
      }
    }
    out += formatted[i];
    i++;
  }
  return out;
}

export function renderJsonPreview(rawText: string): string {
  if (rawText.trim().length === 0) {
    return `<p class="preview__empty">This file is empty.</p>`;
  }
  let formatted: string;
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(rawText);
    formatted = JSON.stringify(parsed, null, 2);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
    formatted = rawText;
  }
  const body = colorizeJson(esc(formatted));
  const errorBanner = parseError
    ? `<p class="preview__error" role="alert">Invalid JSON (${esc(parseError)}). Showing the file verbatim.</p>`
    : "";
  return `${errorBanner}<pre class="preview__json"><code>${body}</code></pre>`;
}
