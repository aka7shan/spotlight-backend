/**
 * LLM provider abstraction — Phase 1.2 (CV parsing) + Phase 1.3 (chat).
 *
 * Why this file exists
 * --------------------
 * Callers (routes, services) want one signature:
 *
 *   const { data, usage, modelUsed } = await generateStructured({...});
 *
 * They should not know — or have to switch on — which provider served
 * the request. This file owns:
 *
 *   - **Provider isolation**  — only this file imports `groq-sdk` and
 *     `@google/genai`. Swapping a provider is a one-file change.
 *
 *   - **Failure normalization** — each SDK throws its own zoo of error
 *     shapes (quota, content-policy, schema, network…). We funnel them
 *     into a single `LlmError` with a categorical `kind`.
 *
 *   - **Schema portability** — providers disagree on schema dialect.
 *     Groq accepts standard JSON Schema directly (via OpenAI-style tool
 *     calls). Gemini wants its proprietary `Schema` type. Callers pass
 *     a neutral `JsonSchema` and we convert per-provider.
 *
 *   - **Auto-fallback** — if the configured primary returns a `quota`
 *     or `transient` error AND the other provider is also configured,
 *     we retry once via the fallback. This is the cheapest possible
 *     defense against single-provider outages.
 *
 *   - **Telemetry surface** — every call returns a `usage` block + the
 *     `modelUsed`. Centralising here means cost dashboards become a
 *     one-place addition later.
 *
 * What this file does NOT do
 * --------------------------
 *  - Owns no JSON schemas. Each feature defines its own and passes it in
 *    (CV parse uses `cvParseSchema` in `services/cv-parse.ts`).
 *  - Owns no prompts. Same reason — keeps prompts co-located with the
 *    feature that owns the behavior.
 */

import { GoogleGenAI, Type as GenAiType, type Schema as GenAiSchema } from '@google/genai';
import Groq from 'groq-sdk';

import {
  env,
  GeminiNotConfiguredError,
  GroqNotConfiguredError,
  NoLlmProviderConfiguredError,
  requireGemini,
  requireGroq,
} from '../env.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Categorical LLM error so the route layer can map to HTTP status codes
 * without string-matching against provider-specific messages.
 */
export type LlmErrorKind =
  /** Provider returned a quota / rate-limit error. Route should 429. */
  | 'quota'
  /** Prompt or response was filtered by safety policies. Route should 422. */
  | 'content-policy'
  /** The provider's response didn't match the requested JSON schema. */
  | 'invalid-response'
  /** Transient (network, timeout, 5xx). Route should 502 + retry advice. */
  | 'transient'
  /** No provider configured at all. Route should 503. */
  | 'not-configured'
  /** Anything else — provider bug or unexpected SDK shape. */
  | 'unknown';

export class LlmError extends Error {
  kind: LlmErrorKind;
  /** Which provider raised this. Useful for logging + dashboards. */
  provider: ProviderName;
  cause?: unknown;

  constructor(
    kind: LlmErrorKind,
    message: string,
    provider: ProviderName,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = provider;
    this.cause = cause;
  }
}

export type ProviderName = 'groq' | 'gemini';

/**
 * Provider-neutral JSON Schema subset.
 *
 * This is the OpenAI-compatible dialect (the most widely adopted one,
 * accepted as-is by Groq's tool-calling API). For Gemini we walk this
 * tree and emit its proprietary `Schema` shape — see `toGeminiSchema`.
 *
 * We deliberately model a SUBSET. Features outside this subset:
 *
 *   - `oneOf` / `anyOf`             — Gemini support is patchy; avoid.
 *   - `format` ("email", "uri", …)  — see comment in cv-parse.ts: real-
 *                                     world CVs have valid-but-spec-
 *                                     rejected emails. Skip strict
 *                                     formats and validate downstream.
 *   - `null` type                   — Gemini has no equivalent. Use
 *                                     optional (omitted from `required`)
 *                                     instead.
 *
 * If you need anything beyond this subset, add it here AND extend
 * `toGeminiSchema` in lockstep.
 */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  /** For type='object'. */
  properties?: Record<string, JsonSchema>;
  /** For type='object'. Names of required properties. */
  required?: readonly string[];
  /** For type='array'. */
  items?: JsonSchema;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateStructuredArgs<T> {
  /** Free-form natural-language instructions ("You are a CV parser…"). */
  systemInstruction?: string;
  /** The actual user-side input — the CV text in our case. */
  userPrompt: string;
  /**
   * JSON schema the model MUST follow. Both providers enforce this at
   * decode time (not just via prompting) — Groq via tool-calling,
   * Gemini via responseSchema.
   */
  schema: JsonSchema;
  /**
   * Optional: parse + validate the raw response into a typed object.
   *
   * Throw from this callback to indicate validation failure; we'll wrap
   * it as an `LlmError({kind:'invalid-response'})` for consistent
   * upstream handling.
   */
  validate?: (parsed: unknown) => T;
  /** Override the model name. Defaults to the provider's configured model. */
  model?: string;
  /** Decoding temperature. Lower = more deterministic. Default 0.1. */
  temperature?: number;
  /**
   * Force a specific provider for this call (bypasses LLM_PROVIDER env).
   * Used by the auto-fallback path; callers should leave this unset.
   */
  forceProvider?: ProviderName;
}

export interface GenerateStructuredResult<T> {
  /** The validated, typed result (if `validate` was provided). Otherwise
   *  the `JSON.parse`d object as `unknown`. */
  data: T;
  /** Raw text the model returned. Useful for debugging mis-parses. */
  raw: string;
  usage: LlmUsage;
  /** The model id that actually served this request. */
  modelUsed: string;
  /** Which provider actually served this request. */
  provider: ProviderName;
}

// ---------------------------------------------------------------------------
// Module-level dispatcher
// ---------------------------------------------------------------------------
//
// We lazy-construct provider clients on first use so:
//  - importing this module never crashes if a key is missing
//  - cold-start cost is paid only by routes that actually call the LLM
//  - cached client survives subsequent invocations on the same warm
//    Vercel instance (SDKs open TLS channels we don't want to rebuild)

let _groqClient: Groq | null = null;
let _geminiClient: GoogleGenAI | null = null;

/** Resolved list of providers to try, primary first. */
function resolveProviderOrder(): ProviderName[] {
  const primary = env.LLM_PROVIDER;
  const fallback: ProviderName = primary === 'groq' ? 'gemini' : 'groq';

  const order: ProviderName[] = [];
  if (isProviderConfigured(primary)) order.push(primary);
  if (isProviderConfigured(fallback)) order.push(fallback);
  return order;
}

function isProviderConfigured(p: ProviderName): boolean {
  return p === 'groq' ? Boolean(env.GROQ_API_KEY) : Boolean(env.GEMINI_API_KEY);
}

/**
 * The public entrypoint every feature calls.
 *
 * Picks the configured primary, falls back to the secondary on
 * `quota` or `transient` errors only (the categories where retrying
 * with a different provider has a real chance of succeeding).
 *
 * Other error kinds bubble up to the caller — they typically indicate
 * something is wrong with our request (schema, prompt, safety) that
 * retrying with a different provider won't fix.
 */
export async function generateStructured<T = unknown>(
  args: GenerateStructuredArgs<T>,
): Promise<GenerateStructuredResult<T>> {
  // forceProvider is the auto-fallback mechanism's escape hatch — used
  // internally only, callers should leave it undefined.
  const order = args.forceProvider
    ? [args.forceProvider]
    : resolveProviderOrder();

  if (order.length === 0) {
    throw new LlmError(
      'not-configured',
      new NoLlmProviderConfiguredError().message,
      env.LLM_PROVIDER,
      new NoLlmProviderConfiguredError(),
    );
  }

  let lastErr: LlmError | undefined;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i]!;
    try {
      return await callProvider(provider, args);
    } catch (err) {
      const llmErr = err instanceof LlmError ? err : null;
      if (!llmErr) throw err; // Unexpected non-LlmError — bubble up.

      lastErr = llmErr;

      // Decide whether to try the next provider.
      const canFallback =
        i < order.length - 1 &&
        (llmErr.kind === 'quota' || llmErr.kind === 'transient');

      if (!canFallback) throw llmErr;

      // Log the fallback transition so operators can see it in Vercel logs.
      // Don't log the prompt — too much noise + potential PII.
      console.warn(
        `[llm] primary=${provider} returned kind=${llmErr.kind}; falling back to ${order[i + 1]}`,
      );
    }
  }

  // Unreachable in practice — the loop throws either on success-return,
  // on the last iteration's error, or on a non-fallback error mid-loop.
  // We keep it for type-safety + as a paranoid safety net.
  throw lastErr ?? new LlmError('unknown', 'No LLM providers were tried.', env.LLM_PROVIDER);
}

async function callProvider<T>(
  provider: ProviderName,
  args: GenerateStructuredArgs<T>,
): Promise<GenerateStructuredResult<T>> {
  if (provider === 'groq') return runGroq(args);
  return runGemini(args);
}

// ---------------------------------------------------------------------------
// Groq provider
// ---------------------------------------------------------------------------
//
// Strategy: tool calling. We define a single tool whose `parameters`
// JSON schema IS the output schema, then force the model to call it
// via `tool_choice`. The model's response then arrives as a function-
// call argument string, which we JSON.parse.
//
// Why tool-calling instead of `response_format: {type:'json_object'}`?
//   - `json_object` mode only guarantees valid JSON, NOT schema match.
//     The model can still return free-form keys, fewer/more fields, etc.
//   - Tool-calling forces the SDK + model to honor the schema, the
//     same way OpenAI's structured-output mode does. It's the only
//     reliable schema-enforcement primitive Groq exposes today.

function getGroqClient(): Groq {
  if (_groqClient) return _groqClient;
  const { apiKey } = requireGroq();
  _groqClient = new Groq({ apiKey });
  return _groqClient;
}

const GROQ_TOOL_NAME = 'submit_structured_output';

async function runGroq<T>(
  args: GenerateStructuredArgs<T>,
): Promise<GenerateStructuredResult<T>> {
  const { model: defaultModel } = requireGroq();
  const modelUsed = args.model ?? defaultModel;
  const client = getGroqClient();

  type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
  };

  // The messages we'll send. If the first attempt fails with
  // `tool_use_failed` (a structured-output schema violation), we
  // append a corrective system message and retry ONCE. Real-world
  // observation: Llama-class models frequently invent enum values
  // ("Live" for a project status, etc.) on the first pass and
  // self-correct reliably when fed the precise error.
  const baseMessages: ChatMessage[] = [
    ...(args.systemInstruction
      ? [{ role: 'system' as const, content: args.systemInstruction }]
      : []),
    { role: 'user' as const, content: args.userPrompt },
  ];

  const callGroq = (messages: ChatMessage[]) =>
    client.chat.completions.create({
      model: modelUsed,
      temperature: args.temperature ?? 0.1,
      messages,
      tools: [
        {
          type: 'function',
          function: {
            name: GROQ_TOOL_NAME,
            description:
              'Submit the structured extraction result. Always call this exactly once.',
            // Groq accepts standard JSON Schema directly — no conversion
            // needed. We do a `as unknown as` cast because the SDK's
            // FunctionParameters type is `Record<string, unknown>` which
            // our typed JsonSchema doesn't structurally satisfy.
            parameters: args.schema as unknown as Record<string, unknown>,
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: GROQ_TOOL_NAME },
      },
    }) as Promise<Awaited<ReturnType<typeof client.chat.completions.create>>>;

  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await callGroq(baseMessages);
  } catch (err) {
    // Special-case tool_use_failed: the model produced output that
    // violated our schema (typically a bad enum value). Retry ONCE
    // with the validator's complaint appended as a system message —
    // models reliably self-correct given the precise error.
    const info = parseGroqApiError(err);
    if (info?.code === 'tool_use_failed' && info.detail) {
      console.warn(
        `[llm.groq] tool_use_failed on first attempt; retrying with corrective hint. detail=${info.detail.slice(0, 200)}`,
      );
      try {
        completion = await callGroq([
          ...baseMessages,
          {
            role: 'system',
            content: [
              'Your previous response failed schema validation. Re-emit the structured output, this time obeying the schema exactly.',
              '',
              'Validator complaint:',
              info.detail,
              '',
              'Re-emit the JSON now. Use ONLY the enum values listed in the schema. Do NOT invent new values.',
            ].join('\n'),
          },
        ]);
      } catch (retryErr) {
        // Retry also failed — surface the retry error so the caller
        // sees the freshest diagnostic, not the stale first one.
        throw mapGroqError(retryErr);
      }
    } else {
      throw mapGroqError(err);
    }
  }

  // Narrow off the streaming-completion union — we never request a stream.
  if (!('choices' in completion)) {
    throw new LlmError(
      'invalid-response',
      'Groq returned a streaming response despite a non-stream request.',
      'groq',
    );
  }

  const choice = completion.choices[0];
  if (!choice) {
    throw new LlmError(
      'invalid-response',
      'Groq returned no choices.',
      'groq',
    );
  }

  const toolCalls = choice.message.tool_calls ?? [];
  const call = toolCalls.find((tc) => tc.function.name === GROQ_TOOL_NAME);
  if (!call) {
    // Model declined to call the tool — usually means it refused the
    // request. Treat as content-policy if a refusal-shaped message is
    // present, else as invalid-response.
    const content = choice.message.content ?? '';
    const lower = content.toLowerCase();
    if (
      lower.includes('cannot') ||
      lower.includes('refuse') ||
      lower.includes('unable to')
    ) {
      throw new LlmError(
        'content-policy',
        'Provider refused the request.',
        'groq',
      );
    }
    throw new LlmError(
      'invalid-response',
      'Model did not invoke the structured-output tool.',
      'groq',
    );
  }

  const raw = call.function.arguments ?? '';
  if (!raw) {
    throw new LlmError(
      'invalid-response',
      'Model returned an empty tool-call argument.',
      'groq',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LlmError(
      'invalid-response',
      'Model returned malformed JSON in tool call.',
      'groq',
      err,
    );
  }

  const data = applyValidate(parsed, args.validate, 'groq');

  return {
    data,
    raw,
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    modelUsed,
    provider: 'groq',
  };
}

/**
 * Structured view of the error body Groq returns. Their SDK wraps
 * everything as a single string on `message` (with the JSON body
 * inlined), so we parse it back out here.
 *
 * Why parse it
 * ------------
 * The error body's nested `code` / `type` are the ONLY reliable
 * categorization signal. Trying to substring-match on the message
 * field is dangerous because the message often contains the
 * user-provided prompt or the model's free-form text — and that
 * text can legitimately contain words like "rate limit" (e.g. a
 * user with a rate-limiter project on their CV) which would
 * mis-categorize their schema-validation error as a quota error.
 *
 * Real example that bit us: a user's CV had "API Rate Limiter" in a
 * project name; the validator-rejection 400 got mis-mapped to quota,
 * the dispatcher fell back to Gemini, Gemini was unconfigured, and
 * the user saw 429 for what was actually a model schema-violation.
 */
function parseGroqApiError(err: unknown): {
  status?: number;
  /** The HTTP/SDK-level error code if one exists. */
  topCode?: string;
  /** The provider's structured error code from the JSON body. */
  code?: string;
  /** The provider's `type` from the JSON body. */
  type?: string;
  /**
   * A short human-readable detail extracted from the structured
   * body. For `tool_use_failed`, this is the validator's complaint.
   */
  detail?: string;
} | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const topCode = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  // Groq's SDK builds `message` as `"<status> <jsonBody>"`. Find the
  // first '{' and parse from there. If parsing fails we still return
  // status/topCode so the outer mapper can fall back to those.
  const braceIdx = message.indexOf('{');
  if (braceIdx === -1) return { status, topCode };

  let body: unknown;
  try {
    body = JSON.parse(message.slice(braceIdx));
  } catch {
    return { status, topCode };
  }
  if (!body || typeof body !== 'object') return { status, topCode };

  const bodyErr = (body as { error?: unknown }).error;
  if (!bodyErr || typeof bodyErr !== 'object') return { status, topCode };

  const code =
    typeof (bodyErr as { code?: unknown }).code === 'string'
      ? ((bodyErr as { code: string }).code)
      : undefined;
  const type =
    typeof (bodyErr as { type?: unknown }).type === 'string'
      ? ((bodyErr as { type: string }).type)
      : undefined;
  const detail =
    typeof (bodyErr as { message?: unknown }).message === 'string'
      ? ((bodyErr as { message: string }).message)
      : undefined;

  return { status, topCode, code, type, detail };
}

function mapGroqError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof GroqNotConfiguredError) {
    return new LlmError('not-configured', err.message, 'groq', err);
  }

  const info = parseGroqApiError(err);
  const status = info?.status;
  const code = info?.code ?? info?.topCode;
  const type = info?.type;
  const detail = info?.detail;

  // Log the structured view server-side so future diagnostics have a
  // chance even if categorization here ends up wrong.
  console.error('[llm.groq] sdk error', {
    status,
    code,
    type,
    // Truncate detail because Groq sometimes echoes the entire failed
    // generation back (multi-KB) and that bloats logs without adding
    // diagnostic value past the first few hundred chars.
    detail: detail?.slice(0, 500),
  });

  // 1. Genuine rate limiting. ONLY trust status=429 and explicit code
  //    fields — never substring-match the message, which often
  //    contains user/model text.
  if (status === 429 || code === 'rate_limit_exceeded') {
    return new LlmError(
      'quota',
      'AI provider rate limit reached. Try again shortly.',
      'groq',
      err,
    );
  }

  // 2. Schema-violation / bad request. The tool-call validator's
  //    `tool_use_failed` is the most common version; the generic
  //    `invalid_request_error` type covers the rest.
  if (
    code === 'tool_use_failed' ||
    code === 'invalid_request_error' ||
    type === 'invalid_request_error' ||
    status === 400
  ) {
    return new LlmError(
      'invalid-response',
      detail
        ? `Model output failed schema validation: ${detail.slice(0, 200)}`
        : 'Model output failed schema validation.',
      'groq',
      err,
    );
  }

  // 3. Auth/config issues (bad key, etc.). Don't fall back — the user
  //    needs to fix configuration.
  if (status === 401 || status === 403 || code === 'invalid_api_key') {
    return new LlmError(
      'not-configured',
      'AI provider rejected our credentials. Check GROQ_API_KEY.',
      'groq',
      err,
    );
  }

  // 4. Content-policy. Groq surfaces this through dedicated codes,
  //    not via a substring search.
  if (
    code === 'content_filter' ||
    code === 'safety_violation' ||
    type === 'content_policy_violation'
  ) {
    return new LlmError(
      'content-policy',
      'Provider refused the request on safety grounds.',
      'groq',
      err,
    );
  }

  // 5. Transient (server / gateway issues).
  if (status === 502 || status === 503 || status === 504) {
    return new LlmError(
      'transient',
      'AI provider is temporarily unavailable.',
      'groq',
      err,
    );
  }

  // Network-level errors don't have a status; the SDK wraps them as
  // `APIConnectionError` etc. Detect the SDK error name as the last
  // resort signal before giving up.
  const errName =
    typeof (err as { name?: unknown })?.name === 'string'
      ? ((err as { name: string }).name)
      : undefined;
  if (
    errName === 'APIConnectionError' ||
    errName === 'APIConnectionTimeoutError'
  ) {
    return new LlmError(
      'transient',
      'AI provider is temporarily unavailable.',
      'groq',
      err,
    );
  }

  return new LlmError(
    'unknown',
    detail || (err instanceof Error ? err.message : 'Unknown AI provider error.'),
    'groq',
    err,
  );
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

function getGeminiClient(): GoogleGenAI {
  if (_geminiClient) return _geminiClient;
  const { apiKey } = requireGemini();
  _geminiClient = new GoogleGenAI({ apiKey });
  return _geminiClient;
}

async function runGemini<T>(
  args: GenerateStructuredArgs<T>,
): Promise<GenerateStructuredResult<T>> {
  const { model: defaultModel } = requireGemini();
  const modelUsed = args.model ?? defaultModel;
  const client = getGeminiClient();

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model: modelUsed,
      contents: args.userPrompt,
      config: {
        systemInstruction: args.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(args.schema),
        temperature: args.temperature ?? 0.1,
      },
    });
  } catch (err) {
    throw mapGeminiError(err);
  }

  const raw = response.text ?? '';
  if (!raw) {
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      throw new LlmError(
        'content-policy',
        `The provider refused to process this request: ${blocked}.`,
        'gemini',
      );
    }
    throw new LlmError(
      'invalid-response',
      'Model returned an empty response.',
      'gemini',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LlmError(
      'invalid-response',
      'Model returned malformed JSON despite schema constraint.',
      'gemini',
      err,
    );
  }

  const data = applyValidate(parsed, args.validate, 'gemini');

  const usage = response.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;

  return {
    data,
    raw,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
    modelUsed,
    provider: 'gemini',
  };
}

function mapGeminiError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof GeminiNotConfiguredError) {
    return new LlmError('not-configured', err.message, 'gemini', err);
  }

  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? ((err as { status: number }).status as number)
      : typeof (err as { code?: unknown })?.code === 'number'
        ? ((err as { code: number }).code as number)
        : undefined;

  // Try to extract Google's structured `status` field
  // (RESOURCE_EXHAUSTED, INVALID_ARGUMENT, etc.) from the body. Same
  // rationale as the Groq parser: substring-matching the message is
  // dangerous because it often contains the model's free-form text
  // or the user's prompt.
  let googleStatus: string | undefined;
  const braceIdx = message.indexOf('{');
  if (braceIdx !== -1) {
    try {
      const body = JSON.parse(message.slice(braceIdx)) as {
        error?: { status?: unknown };
      };
      if (typeof body?.error?.status === 'string') {
        googleStatus = body.error.status;
      }
    } catch {
      // Body wasn't JSON. We'll fall through and use status alone.
    }
  }

  console.error('[llm.gemini] sdk error', {
    status,
    googleStatus,
    // Truncate to keep logs tidy.
    message: message.slice(0, 500),
  });

  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return new LlmError(
      'quota',
      'AI provider rate limit reached. Try again shortly.',
      'gemini',
      err,
    );
  }
  if (
    googleStatus === 'PERMISSION_DENIED' ||
    googleStatus === 'UNAUTHENTICATED' ||
    status === 401 ||
    status === 403
  ) {
    return new LlmError(
      'not-configured',
      'AI provider rejected our credentials. Check GEMINI_API_KEY and project quota.',
      'gemini',
      err,
    );
  }
  if (
    googleStatus === 'INVALID_ARGUMENT' ||
    status === 400
  ) {
    return new LlmError(
      'invalid-response',
      'Provider rejected the request as invalid.',
      'gemini',
      err,
    );
  }
  if (
    googleStatus === 'UNAVAILABLE' ||
    googleStatus === 'DEADLINE_EXCEEDED' ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return new LlmError(
      'transient',
      'AI provider is temporarily unavailable.',
      'gemini',
      err,
    );
  }
  return new LlmError(
    'unknown',
    message || 'Unknown AI provider error.',
    'gemini',
    err,
  );
}

/**
 * Recursively translate our neutral `JsonSchema` into Gemini's
 * proprietary `Schema` shape. The two are nearly identical at the
 * leaf level but differ in case (`'object'` vs `Type.OBJECT`).
 *
 * Kept narrow on purpose: an unrecognized field is silently dropped
 * rather than mistranslated. If you add a new field to `JsonSchema`,
 * extend the mapping here in lockstep.
 */
function toGeminiSchema(s: JsonSchema): GenAiSchema {
  const out: GenAiSchema = {
    type: jsonTypeToGenAi(s.type),
  };
  if (s.description) out.description = s.description;
  if (s.enum && s.enum.length > 0) out.enum = [...s.enum];

  if (s.type === 'object' && s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
    if (s.required && s.required.length > 0) out.required = [...s.required];
  }
  if (s.type === 'array' && s.items) {
    out.items = toGeminiSchema(s.items);
  }
  return out;
}

function jsonTypeToGenAi(t: JsonSchema['type']): GenAiType {
  switch (t) {
    case 'object':
      return GenAiType.OBJECT;
    case 'string':
      return GenAiType.STRING;
    case 'number':
      return GenAiType.NUMBER;
    case 'integer':
      return GenAiType.INTEGER;
    case 'boolean':
      return GenAiType.BOOLEAN;
    case 'array':
      return GenAiType.ARRAY;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function applyValidate<T>(
  parsed: unknown,
  validate: ((p: unknown) => T) | undefined,
  provider: ProviderName,
): T {
  if (!validate) return parsed as T;
  try {
    return validate(parsed);
  } catch (err) {
    throw new LlmError(
      'invalid-response',
      err instanceof Error ? err.message : 'Model response failed validation.',
      provider,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Test-seam: reset cached clients (used by Vitest setup in the future)
// ---------------------------------------------------------------------------

/**
 * Drop the cached provider clients. Tests that swap env vars between
 * cases need this so subsequent calls pick up the new credentials.
 *
 * Production code should never call this — the caching is a perf win
 * we don't want to throw away on every request.
 */
export function __resetLlmClientsForTest(): void {
  _groqClient = null;
  _geminiClient = null;
}
