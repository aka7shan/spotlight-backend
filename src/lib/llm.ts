/**
 * Thin LLM wrapper — Phase 1.2 (CV parsing) + Phase 1.3 (chat).
 *
 * Why a wrapper?
 * --------------
 *  - **Provider isolation**: only this file imports `@google/genai`. Routes
 *    and services depend on `generateStructured(...)` / `streamChat(...)`,
 *    not on a specific SDK shape. Swapping to OpenAI/Anthropic later is a
 *    one-file change.
 *  - **Failure normalization**: the Google SDK throws a small zoo of error
 *    shapes (quota, content-policy, network, bad-schema, etc.). We
 *    funnel all of those into a single `LlmError` with a categorical
 *    `kind` field so callers can render appropriate UX.
 *  - **Telemetry surface**: every call returns a `usage` block. Centralizing
 *    here means there's one place to add cost-tracking later without
 *    touching every callsite.
 *
 * What this file does NOT do
 * --------------------------
 *  - It does not own the JSON schema. Each feature defines its own schema
 *    (CV parse uses `cvParseResponseSchema` in `services/cv-parse.ts`) and
 *    passes it in.
 *  - It does not own the prompt template. Same reason — keeps prompts
 *    co-located with the feature that owns the behavior.
 */

import { GoogleGenAI, type Schema as GenAiSchema } from '@google/genai';

import { GeminiNotConfiguredError, requireGemini } from '../env.js';

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------
//
// Categorical error so the route can return a useful status code without
// having to string-match against the Google SDK's internal messages.

export type LlmErrorKind =
  /** Provider returned a quota / rate-limit error. Route should 429. */
  | 'quota'
  /** Prompt or response was filtered by safety policies. Route should 400. */
  | 'content-policy'
  /** The provider's response didn't match the requested JSON schema. */
  | 'invalid-response'
  /** Transient (network, timeout). Route should 502 + retry advice. */
  | 'transient'
  /** Anything else — provider bug or unexpected SDK shape. */
  | 'unknown';

export class LlmError extends Error {
  kind: LlmErrorKind;
  cause?: unknown;

  constructor(kind: LlmErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.cause = cause;
  }
}

// Re-export the SDK's Schema type so callers can build typed schemas without
// reaching into `@google/genai`. We deliberately keep this an *alias* (not
// a wrapper interface) so we don't have to manually mirror the entire
// schema dialect — and if Google adds a new constraint we get it for free.
export type LlmSchema = GenAiSchema;

// Standard usage shape we expose to callers. The SDK returns more detailed
// per-modality counters; we collapse to in/out tokens because that's what
// every billing/cost calculation actually needs.
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Client (lazy singleton)
// ---------------------------------------------------------------------------
//
// The SDK opens a TLS-bound HTTP/2 channel on construction. Caching it
// across invocations is critical for serverless cold-start latency:
// rebuilding it on every request adds ~150ms of handshake.

let _client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (_client) return _client;
  const { apiKey } = requireGemini();
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// ---------------------------------------------------------------------------
// Structured (JSON-schema) generation
// ---------------------------------------------------------------------------

export interface GenerateStructuredArgs<T> {
  /** Free-form natural-language instructions ("You are a CV parser..."). */
  systemInstruction?: string;
  /** The actual user-side input — the CV text in our case. */
  userPrompt: string;
  /**
   * JSON schema the model MUST follow. Gemini enforces this at decode
   * time (not just via prompting), which is why we picked this provider.
   */
  schema: LlmSchema;
  /**
   * Optional: parse + validate the raw response into a typed object.
   * If omitted, callers get back the JSON string + a `JSON.parse`d
   * value of unknown shape.
   *
   * Throw from this callback to indicate validation failure; we'll wrap
   * it as an `LlmError({kind:'invalid-response'})` for consistent
   * upstream handling.
   */
  validate?: (parsed: unknown) => T;
  /** Override the model name. Defaults to `env.GEMINI_MODEL`. */
  model?: string;
  /**
   * Decoding temperature. Lower = more deterministic, which is what we
   * want for structured extraction. Default 0.1.
   */
  temperature?: number;
}

export interface GenerateStructuredResult<T> {
  /** The validated, typed result (if `validate` was provided). Otherwise
   *  the `JSON.parse`d object as `unknown`. */
  data: T;
  /** Raw text the model returned. Useful for debugging mis-parses. */
  raw: string;
  usage: LlmUsage;
  /** The Gemini model id that actually served this request. */
  modelUsed: string;
}

/**
 * Run a structured (JSON-schema-constrained) generation against Gemini.
 *
 * Why this signature?
 * -------------------
 *  - **Generic over the validated type**: the call site stays type-safe
 *    end-to-end. The CV parser's `validate` returns a `CvParseResult`
 *    and the consumer gets exactly that back, with no `as` casts.
 *  - **`validate` is optional**: not every call wants to pay for Zod-style
 *    runtime validation (the SDK already enforces the schema at decode
 *    time). When provided, validation failures map to a clean LlmError.
 *  - **Errors are categorical, not stringly-typed**: every throw funnels
 *    through `LlmError` with a typed `kind`. The route layer pattern-
 *    matches on `kind` to pick HTTP status + user-facing message.
 */
export async function generateStructured<T = unknown>(
  args: GenerateStructuredArgs<T>,
): Promise<GenerateStructuredResult<T>> {
  const { model: overrideModel } = args;
  const { model: defaultModel } = requireGemini();
  const modelUsed = overrideModel ?? defaultModel;

  const client = getClient();

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model: modelUsed,
      contents: args.userPrompt,
      config: {
        // System instruction is sent as its own block so the model
        // treats it as guidance rather than as content to summarize.
        systemInstruction: args.systemInstruction,

        // Gemini's "JSON mode" + a response schema is the key feature
        // we're leaning on: the SDK constrains the decoder so the
        // returned text is *guaranteed* to be valid JSON matching the
        // shape. Without this, structured extraction would be the
        // brittle string-parsing nightmare it usually is.
        responseMimeType: 'application/json',
        responseSchema: args.schema,
        temperature: args.temperature ?? 0.1,
      },
    });
  } catch (err) {
    throw mapSdkError(err);
  }

  const raw = response.text ?? '';
  if (!raw) {
    // Empty text on a successful call usually means the safety filter
    // blocked the response. Distinguish from network/empty errors
    // because the user-facing message differs.
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      throw new LlmError(
        'content-policy',
        `The provider refused to process this request: ${blocked}.`,
      );
    }
    throw new LlmError('invalid-response', 'Model returned an empty response.');
  }

  // The schema-constrained path always returns valid JSON. If it doesn't,
  // that's an SDK regression — treat as invalid-response so the caller
  // can decide whether to retry or surface the error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LlmError(
      'invalid-response',
      'Model returned malformed JSON despite schema constraint.',
      err,
    );
  }

  let data: T;
  if (args.validate) {
    try {
      data = args.validate(parsed);
    } catch (err) {
      throw new LlmError(
        'invalid-response',
        err instanceof Error ? err.message : 'Model response failed validation.',
        err,
      );
    }
  } else {
    data = parsed as T;
  }

  return {
    data,
    raw,
    usage: extractUsage(response),
    modelUsed,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull token counts out of the SDK response. Gemini reports separate
 * "candidate" and "prompt" counts; we collapse to {input, output} as the
 * universal billing unit.
 *
 * Defensive about missing fields: if the SDK shape changes, log a zero
 * instead of crashing the request. The caller's main path is the
 * generated data, not the usage telemetry.
 */
function extractUsage(response: { usageMetadata?: unknown }): LlmUsage {
  const meta = response.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
  };
}

/**
 * Translate the Google SDK's error zoo into a categorical `LlmError`.
 *
 * The SDK doesn't expose stable error classes — we have to inspect
 * `message` and HTTP-style status codes when present. Each branch is
 * narrow on purpose so future SDK changes don't silently regress: an
 * unknown shape lands in `kind:'unknown'` and gets logged with the
 * original error preserved as `cause` for debugging.
 */
function mapSdkError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof GeminiNotConfiguredError) {
    return new LlmError('unknown', err.message, err);
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // The SDK's HTTP layer surfaces status via either a numeric `status`
  // or a `code` property on REST-error shapes.
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? ((err as { status: number }).status as number)
      : typeof (err as { code?: unknown })?.code === 'number'
        ? ((err as { code: number }).code as number)
        : undefined;

  if (status === 429 || lower.includes('quota') || lower.includes('rate limit')) {
    return new LlmError('quota', 'AI provider rate limit reached. Try again shortly.', err);
  }
  if (lower.includes('safety') || lower.includes('blocked') || lower.includes('harm')) {
    return new LlmError('content-policy', 'Provider refused the request on safety grounds.', err);
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('timeout') ||
    lower.includes('temporar')
  ) {
    return new LlmError('transient', 'AI provider is temporarily unavailable.', err);
  }
  return new LlmError('unknown', message || 'Unknown AI provider error.', err);
}
