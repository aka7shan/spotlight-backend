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

  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = (await client.chat.completions.create({
      model: modelUsed,
      temperature: args.temperature ?? 0.1,
      messages: [
        ...(args.systemInstruction
          ? [{ role: 'system' as const, content: args.systemInstruction }]
          : []),
        { role: 'user' as const, content: args.userPrompt },
      ],
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
    })) as Awaited<ReturnType<typeof client.chat.completions.create>>;
  } catch (err) {
    throw mapGroqError(err);
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

function mapGroqError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof GroqNotConfiguredError) {
    return new LlmError('not-configured', err.message, 'groq', err);
  }

  // The Groq SDK throws OpenAI-shaped APIError objects with a numeric
  // `status` and a string `code`. We pattern-match on both.
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
  };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const lower = (message + ' ' + (code ?? '')).toLowerCase();

  // Log the original error server-side so future diagnostics have a
  // chance. We don't surface the raw message to the client by default
  // because it sometimes contains route/internal hints we'd rather not
  // expose.
  console.error('[llm.groq] sdk error', {
    status,
    code,
    message,
  });

  if (
    status === 429 ||
    code === 'rate_limit_exceeded' ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return new LlmError(
      'quota',
      'AI provider rate limit reached. Try again shortly.',
      'groq',
      err,
    );
  }
  if (
    lower.includes('safety') ||
    lower.includes('content policy') ||
    lower.includes('content_filter')
  ) {
    return new LlmError(
      'content-policy',
      'Provider refused the request on safety grounds.',
      'groq',
      err,
    );
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('timeout') ||
    lower.includes('temporar')
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
    message || 'Unknown AI provider error.',
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
  const lower = message.toLowerCase();
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? ((err as { status: number }).status as number)
      : typeof (err as { code?: unknown })?.code === 'number'
        ? ((err as { code: number }).code as number)
        : undefined;

  console.error('[llm.gemini] sdk error', {
    status,
    message,
  });

  if (status === 429 || lower.includes('quota') || lower.includes('rate limit')) {
    return new LlmError(
      'quota',
      'AI provider rate limit reached. Try again shortly.',
      'gemini',
      err,
    );
  }
  if (
    lower.includes('safety') ||
    lower.includes('blocked') ||
    lower.includes('harm')
  ) {
    return new LlmError(
      'content-policy',
      'Provider refused the request on safety grounds.',
      'gemini',
      err,
    );
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('timeout') ||
    lower.includes('temporar')
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
