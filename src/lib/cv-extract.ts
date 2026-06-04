/**
 * CV → plain text extraction (Phase 1.2).
 *
 * Why a separate module?
 * ----------------------
 * The LLM stage expects a single string of CV text. Getting from "the
 * user uploaded N bytes" to that string is non-trivial:
 *   - PDF  → needs `unpdf` (a serverless-friendly fork of pdfjs-dist)
 *   - DOCX → needs `mammoth`
 *   - DOC  → not supported (legacy Word; would need libreoffice headless)
 *   - Image-only PDFs (no text layer) → produce empty output; we detect
 *     and raise a clean error so the user sees "couldn't read text"
 *     instead of "the AI returned an empty profile".
 *
 * Output normalization
 * --------------------
 * Both extractors return text with format-specific quirks (page-break
 * markers, double-newlines around headings, trailing whitespace from
 * justified text). We pipe through a small `normalize` step so the
 * LLM sees a consistent input shape — fewer prompt variants, fewer
 * surprise extractions.
 *
 * Size constraints
 * ----------------
 * Even with the 4 MB upload cap, an extracted CV can sometimes be
 * verbose (multi-page academic CVs, dissertation appendices). We cap
 * the extracted text at 200 KB before sending to the LLM. Anything
 * past that is almost always non-CV content (publications lists,
 * project portfolios pasted inline) that hurts more than it helps —
 * the LLM gets a worse signal-to-noise ratio.
 */

import * as mammoth from 'mammoth';

/**
 * Cap on the extracted text we forward to the LLM.
 *
 * Sized so a normal 1–4 page CV is well under, but a 50-page academic
 * "extended CV with publications" gets truncated. ~50K tokens at the
 * typical English compression ratio.
 */
const MAX_EXTRACTED_TEXT_BYTES = 200 * 1024;

/**
 * Below this threshold we assume the PDF had no text layer (i.e. it's
 * a scan/image) and we want to surface a clear "we couldn't read it"
 * error instead of feeding the LLM a near-empty string and getting
 * back a near-empty profile.
 */
const MIN_USEFUL_TEXT_CHARS = 200;

export type CvExtractFormat = 'pdf' | 'docx' | 'doc';

export class CvExtractionError extends Error {
  kind: 'unsupported-format' | 'no-text' | 'corrupt' | 'too-large';
  constructor(kind: CvExtractionError['kind'], message: string) {
    super(message);
    this.name = 'CvExtractionError';
    this.kind = kind;
  }
}

export interface CvExtractResult {
  /** Normalized plain-text CV body. Safe to feed directly to the LLM. */
  text: string;
  /** How many bytes the *normalized* text takes up. */
  bytes: number;
  /** Whether we truncated. The caller may want to warn the user. */
  truncated: boolean;
}

/**
 * Extract plain text from a CV file. Dispatches by format.
 *
 * @throws CvExtractionError on any failure with a typed `kind`. The route
 *         layer maps kinds to HTTP status codes / user-facing copy.
 */
export async function extractCvText(
  bytes: Uint8Array,
  format: CvExtractFormat,
): Promise<CvExtractResult> {
  let raw: string;
  switch (format) {
    case 'pdf':
      raw = await extractPdf(bytes);
      break;
    case 'docx':
      raw = await extractDocx(bytes);
      break;
    case 'doc':
      // The legacy .doc format requires a headless office runtime
      // (libreoffice / antiword) we can't ship into Vercel's serverless
      // image. Surface a clear message and ask the user to re-export.
      throw new CvExtractionError(
        'unsupported-format',
        'Legacy .doc files are not supported. Please upload a PDF or .docx instead.',
      );
    default:
      // Exhaustiveness — TS will flag this if a new format is added to
      // the type without a branch here.
      throw new CvExtractionError('unsupported-format', `Unhandled format: ${format}`);
  }

  const normalized = normalize(raw);

  if (normalized.length < MIN_USEFUL_TEXT_CHARS) {
    // Heuristic — either the PDF is a scan, the DOCX is mostly
    // images, or the file is genuinely tiny. The fix on the user
    // side is the same in all three cases: provide a text-based file.
    throw new CvExtractionError(
      'no-text',
      "We couldn't read any text from this file. If it's a scanned PDF, please upload a text-based version.",
    );
  }

  const bytesLen = byteLength(normalized);
  if (bytesLen <= MAX_EXTRACTED_TEXT_BYTES) {
    return { text: normalized, bytes: bytesLen, truncated: false };
  }

  // Truncate at a UTF-8 byte boundary so we don't split a multi-byte
  // character (which would leave a malformed sequence the LLM has to
  // skip past — minor cost but easy to avoid).
  const truncated = truncateToBytes(normalized, MAX_EXTRACTED_TEXT_BYTES);
  return { text: truncated, bytes: byteLength(truncated), truncated: true };
}

// ---------------------------------------------------------------------------
// Per-format extractors
// ---------------------------------------------------------------------------

/**
 * PDF → text via `unpdf`.
 *
 * Why `unpdf`?
 *  - The mainstream `pdf-parse` package depends on `pdfjs-dist`'s legacy
 *    worker setup, which trips up in Vercel's serverless bundler.
 *  - `unpdf` is a clean, Node + Edge-friendly fork that exposes the same
 *    pdfjs internals without the build gotchas. Maintained by the Nuxt
 *    team, used in their content pipeline.
 */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  // Dynamic import — `unpdf` does a non-trivial amount of work on load
  // (pulls in pdfjs internals). Deferring keeps cold starts for
  // unrelated routes fast.
  let extractText: typeof import('unpdf').extractText;
  try {
    ({ extractText } = await import('unpdf'));
  } catch (_err) {
    // Loader failure is opaque (could be a missing dep in the serverless
    // bundle, an unsupported runtime, etc.). Surface as "corrupt" since
    // there's no actionable distinction for the user.
    throw new CvExtractionError(
      'corrupt',
      'PDF extractor module failed to load on the server.',
    );
  }

  try {
    // unpdf accepts a Uint8Array directly. `mergePages: true` picks the
    // overload whose `text` field is `string` (otherwise it returns
    // `string[]`, one entry per page), saving us a join here.
    const result = await extractText(bytes, { mergePages: true });
    return result.text;
  } catch (_err) {
    throw new CvExtractionError(
      'corrupt',
      'Could not parse this PDF. The file may be corrupt or password-protected.',
    );
  }
}

/**
 * DOCX → text via `mammoth`.
 *
 * Mammoth has two modes:
 *   - `extractRawText`: stripped of formatting, just the text body.
 *   - `convertToHtml`: preserves headings etc. as semantic HTML.
 *
 * For LLM extraction we want the raw text — the model doesn't care
 * about heading styles, and the HTML noise would just eat input
 * tokens.
 */
async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    // mammoth wants a Buffer (Node) or an ArrayBuffer. The byte view's
    // underlying buffer is what we hand over; Buffer.from() avoids a
    // copy.
    const buf = Buffer.from(bytes);
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  } catch (_err) {
    throw new CvExtractionError(
      'corrupt',
      'Could not parse this .docx. The file may be corrupt or password-protected.',
    );
  }
}

// ---------------------------------------------------------------------------
// Normalization & sizing helpers
// ---------------------------------------------------------------------------

/**
 * Light-touch text cleanup so the LLM sees a stable shape regardless
 * of source format:
 *   - Collapse runs of whitespace inside a line (mammoth/unpdf both
 *     emit doubled spaces for justified text).
 *   - Collapse runs of blank lines (3+ → 2). Single + double blank
 *     lines stay because they often delimit sections.
 *   - Normalize Windows-style CRLF to LF.
 *   - Strip leading/trailing whitespace.
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    // Tabs and consecutive non-newline whitespace → single space.
    .replace(/[ \t\f\v]+/g, ' ')
    // Trim per-line trailing whitespace.
    .replace(/ +\n/g, '\n')
    // 3+ blank lines → at most 1 (so "section break" remains visible
    // as a doubled newline, but giant gaps shrink).
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** UTF-8 byte length without allocating a full Buffer. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Truncate to a byte budget without breaking the last UTF-8 codepoint.
 *
 * Approach: encode to bytes, slice, then re-decode with the lossy
 * encoder — invalid trailing bytes become a single U+FFFD. We then
 * strip that replacement char if present so the LLM doesn't see an
 * artefact.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const encoded = Buffer.from(s, 'utf8');
  if (encoded.length <= maxBytes) return s;
  const decoded = encoded.subarray(0, maxBytes).toString('utf8');
  return decoded.replace(/\uFFFD+$/, '').trimEnd();
}
