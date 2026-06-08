/**
 * CV → structured profile extraction (Phase 1.2).
 *
 * Orchestrates three pieces:
 *
 *   1. **Text extraction** (`lib/cv-extract.ts`) — bytes → plain text.
 *   2. **LLM call** (`lib/llm.ts`) — text → typed JSON via Gemini's
 *      structured-output mode.
 *   3. **Wire normalization** (this file) — the LLM's output uses the
 *      *frontend Zod* shape (PascalCase `status`, ISO date strings, etc.)
 *      so the React side can drop it into the existing review UI without
 *      another transform.
 *
 * Why this lives in `services/` and not `routes/`
 * -----------------------------------------------
 * The route layer is for HTTP plumbing (auth, validation, status codes).
 * The actual "load CV, run model, return shaped JSON" pipeline is
 * portable — a future CLI tool, a background batch worker, or a chat
 * agent could call this exact function. Keeping it route-free now
 * means we don't pay a refactor cost later.
 *
 * Why we DON'T persist the parsed result here
 * -------------------------------------------
 * The whole point of the diff-review UX is that the user reviews each
 * section before it touches their profile. If we wrote to the DB up
 * front, we'd have to invent an "uncommitted parse" table and a
 * rollback path. Returning the JSON to the frontend and letting the
 * frontend send accepted parts via PUT /v1/me reuses the entire
 * existing save pipeline — including the validation that runs there.
 */

import {
  CvExtractionError,
  extractCvText,
  type CvExtractFormat,
} from '../lib/cv-extract.js';
import {
  generateStructured,
  LlmError,
  type JsonSchema,
  type LlmUsage,
  type ProviderName,
} from '../lib/llm.js';

// ---------------------------------------------------------------------------
// Output shape — mirrors the frontend Zod enums (PascalCase status etc.)
// ---------------------------------------------------------------------------
//
// This is the shape we promise to return. It maps 1:1 onto the
// frontend's `User` type so the diff UI can render it without
// translation. Each field is optional so the LLM is free to omit
// what it can't infer from the CV (and an empty CV doesn't yield
// fabricated content).
//
// IMPORTANT: keep this in lockstep with `src/schemas/profile.ts` on the
// backend AND `src/types/portfolio.ts` on the frontend. If you add a
// field there, mirror it here AND in the JSON schema below.

export interface CvParseResult {
  // Profile basics. Strings only — the LLM has no way to invent an avatar
  // URL or a userId, and we wouldn't trust it if it tried.
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
  location?: string;
  /** "About me" / professional summary. We hint the LLM to keep it ≤ 400 chars. */
  about?: string;

  socialLinks?: {
    linkedin?: string;
    github?: string;
    twitter?: string;
    website?: string;
    dribbble?: string;
    behance?: string;
  };

  skills?: string[];

  experience?: Array<{
    position: string;
    company: string;
    startDate: string;
    endDate?: string;
    isPresent?: boolean;
    description?: string;
    location?: string;
    skills?: string[];
  }>;

  education?: Array<{
    degree: string;
    institution: string;
    startDate: string;
    endDate?: string;
    isPresent?: boolean;
    gpa?: string;
    description?: string;
    achievements?: string[];
  }>;

  projects?: Array<{
    name: string;
    description: string;
    tags?: string[];
    link?: string;
    githubLink?: string;
    status: 'Completed' | 'In Progress' | 'Planned';
    startDate?: string;
    endDate?: string;
    role?: string;
    technologies?: string[];
    achievements?: string[];
  }>;

  certifications?: Array<{
    name: string;
    issuer: string;
    startDate: string;
    endDate?: string;
    isPresent?: boolean;
    credentialId?: string;
    link?: string;
    expiryDate?: string;
  }>;

  achievements?: Array<{
    title: string;
    description?: string;
    startDate: string;
    organization?: string;
    link?: string;
  }>;

  languages?: Array<{
    name: string;
    level: 'Beginner' | 'Intermediate' | 'Advanced' | 'Fluent' | 'Native' | 'Expert';
    certification?: string;
  }>;
}

export interface CvParseEnvelope {
  data: CvParseResult;
  /** Token usage so the route can log it (and we can build cost dashboards later). */
  usage: LlmUsage;
  /** Model id that served the request. */
  modelUsed: string;
  /** Which provider (`groq` | `gemini`) actually served the request. */
  provider: ProviderName;
  /**
   * Whether the input text was truncated before being sent to the LLM
   * (e.g. a 50-page CV got cut to 200 KB). The frontend can show a
   * gentle warning so the user understands why a trailing section
   * might not appear in the diff.
   */
  inputTruncated: boolean;
  /** Bytes of CV text actually sent to the model. Useful for debugging. */
  inputBytes: number;
}

// ---------------------------------------------------------------------------
// JSON schema (provider-neutral, enforced at decode time)
// ---------------------------------------------------------------------------
//
// Both providers we support enforce this at decode time — Groq via
// tool-calling, Gemini via responseSchema — so it's our load-bearing
// contract, not just hints. A few deliberate choices:
//
//  - Everything optional. Empty CVs and short ones must produce valid
//    output without the model inventing data.
//  - Enums encoded with `enum:` so the model can't return "completed"
//    when we want "Completed" (the wire shape is case-sensitive).
//  - `format: 'email'` etc. is deliberately NOT used — real CVs
//    sometimes have valid emails the spec rejects (subaddressing
//    with `+`, etc.). We accept whatever and let the frontend
//    validator catch the rest.
//  - We use OUR neutral `JsonSchema` type from `lib/llm.ts`, not the
//    Gemini-specific `Schema`. The Gemini provider converts on the way
//    out so we don't leak SDK shapes into the service layer.

const cvParseSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    title: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    location: { type: 'string' },
    about: { type: 'string' },

    socialLinks: {
      type: 'object',
      properties: {
        linkedin: { type: 'string' },
        github: { type: 'string' },
        twitter: { type: 'string' },
        website: { type: 'string' },
        dribbble: { type: 'string' },
        behance: { type: 'string' },
      },
    },

    skills: {
      type: 'array',
      items: { type: 'string' },
    },

    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          position: { type: 'string' },
          company: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          isPresent: { type: 'boolean' },
          description: { type: 'string' },
          location: { type: 'string' },
          skills: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['position', 'company', 'startDate'],
      },
    },

    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          degree: { type: 'string' },
          institution: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          isPresent: { type: 'boolean' },
          gpa: { type: 'string' },
          description: { type: 'string' },
          achievements: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['degree', 'institution', 'startDate'],
      },
    },

    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          link: { type: 'string' },
          githubLink: { type: 'string' },
          status: {
            type: 'string',
            enum: ['Completed', 'In Progress', 'Planned'],
          },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          role: { type: 'string' },
          technologies: {
            type: 'array',
            items: { type: 'string' },
          },
          achievements: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['name', 'description', 'status'],
      },
    },

    certifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          issuer: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          isPresent: { type: 'boolean' },
          credentialId: { type: 'string' },
          link: { type: 'string' },
          expiryDate: { type: 'string' },
        },
        required: ['name', 'issuer', 'startDate'],
      },
    },

    achievements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          startDate: { type: 'string' },
          organization: { type: 'string' },
          link: { type: 'string' },
        },
        required: ['title', 'startDate'],
      },
    },

    languages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          level: {
            type: 'string',
            enum: ['Beginner', 'Intermediate', 'Advanced', 'Fluent', 'Native', 'Expert'],
          },
          certification: { type: 'string' },
        },
        required: ['name', 'level'],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
//
// The system prompt does the heavy lifting. It establishes:
//   - Role/identity (CV parser, not free-form chat).
//   - Output expectations (only-from-source rule, formatting hints).
//   - Field-specific guidance the schema can't capture (date formats,
//     language-level mapping, etc.).
//
// We keep the user-side prompt minimal — just the raw CV text — so the
// model spends its attention budget on the source material rather than
// re-parsing instructions.

const SYSTEM_INSTRUCTION = [
  'You are a structured-extraction assistant. You take the plain text of a candidate\'s CV/résumé and return a JSON object that matches the provided schema.',
  '',
  'CRITICAL RULES (violations cause hard validation failures):',
  '1. Extract ONLY information explicitly present in the CV. Never invent fields.',
  '2. If a field is not in the CV, omit it from the output (do not return empty strings or placeholder values).',
  '3. Output strict JSON — no markdown, no commentary, no surrounding prose.',
  '4. For ANY enum-typed field, use ONLY the exact values listed in the schema. Do NOT invent new enum values, do NOT pick synonyms, do NOT change case. If the CV uses a different word, MAP it to the closest schema value (see explicit mappings below).',
  '',
  'Field-specific guidance:',
  '- `name`: the candidate\'s full name. Strip honorifics ("Dr.", "Mr.") unless they form part of the displayed name.',
  '- `title`: the headline role (e.g. "Senior Backend Engineer"). Prefer the candidate\'s most recent or most prominently displayed title.',
  '- `about`: a 1–3 sentence professional summary, max 400 characters. If the CV has a "Summary" or "Profile" section, use it (paraphrased only if needed for length).',
  '- `email` / `phone`: keep the format as written.',
  '- `location`: city + region if available; otherwise whatever the CV says ("Remote", "San Francisco, CA").',
  '',
  'Dates:',
  '- Use the natural-language form from the CV ("May 2021", "2019 – 2022", "08/2020").',
  '- For ongoing roles ("Present", "Current"), set `isPresent: true` and omit `endDate`.',
  '',
  'Experience:',
  '- One entry per job.',
  '- `description` must be the ORIGINAL CV bullet points, copied VERBATIM, one per line, separated by newlines (\\n).',
  '  * Do NOT rewrite, summarize, paraphrase, condense, or merge bullets.',
  '  * Do NOT join multiple bullets into a single paragraph or comma-separated sentence.',
  '  * Preserve the exact wording, capitalisation, and punctuation the candidate wrote.',
  '  * STRIP leading bullet markers ("•", "*", "-", "→", "◦", "▪") and any leading whitespace. Output the clean bullet text only.',
  '  * If the CV uses prose (no bullets) for this role, copy that prose verbatim without rewriting.',
  '- `skills` here is per-role: technologies/tools mentioned for that specific job.',
  '',
  'Skills (top-level):',
  '- A flat array of distinct technologies, tools, and methodologies. Deduplicate. Preserve original casing ("React", "PostgreSQL").',
  '',
  'Projects:',
  '- Include only when the CV has a dedicated Projects section, or when the section is clearly "personal/side projects" distinct from employment.',
  '- `description` must be the ORIGINAL CV bullet points, copied VERBATIM, one per line, separated by newlines (\\n).',
  '  * Do NOT rewrite, summarize, paraphrase, condense, or merge bullets.',
  '  * Do NOT join multiple bullets into a single paragraph or comma-separated sentence.',
  '  * Preserve the exact wording, capitalisation, and punctuation the candidate wrote.',
  '  * STRIP leading bullet markers ("•", "*", "-", "→", "◦", "▪") and any leading whitespace. Output the clean bullet text only.',
  '  * If the CV gives only a single-line description (no bullets), copy it as-is — do not pad or expand it.',
  '- `status` MUST be EXACTLY one of: "Completed", "In Progress", "Planned". No other values are allowed.',
  '- Mapping for common CV phrasings:',
  '  * "Live" / "Deployed" / "Released" / "Shipped" / "Production" → "Completed"',
  '  * "Ongoing" / "WIP" / "Active" / "Being built" / "Under development" → "In Progress"',
  '  * "Upcoming" / "Future" / "Plan to build" / "TODO" → "Planned"',
  '  * If the project has a finished outcome described in past tense, or no explicit status is given → "Completed"',
  '  * If the project is described as a current effort with no end-date → "In Progress"',
  '- The `link` field is a URL. Do NOT put labels like "GitHub" or "LinkedIn" here — only the actual URL (e.g. "https://github.com/user/repo"). If the CV shows a label without the URL, omit the link field entirely.',
  '',
  'Languages:',
  '- `level` MUST be EXACTLY one of: "Beginner", "Intermediate", "Advanced", "Fluent", "Native", "Expert". No other values allowed.',
  '- Mapping for common CV phrasings:',
  '  * "Basic" / "Elementary" → "Beginner"',
  '  * "Conversational" → "Intermediate"',
  '  * "Working proficiency" / "Professional" → "Advanced"',
  '  * "Full professional" → "Fluent"',
  '  * "Mother tongue" / "First language" → "Native"',
  '',
  'Social links:',
  '- Look for LinkedIn, GitHub, Twitter/X, personal website, Dribbble, Behance. Use full URLs ("https://github.com/foo"); if the CV gives a username only, expand to the canonical URL.',
  '- The schema allows only these specific keys: linkedin, github, twitter, website, dribbble, behance. Do NOT invent additional keys (e.g. "leetcode", "portfolio") — those will be rejected. If the CV has a "Portfolio" link, put it under `website`. Skip anything that doesn\'t map to one of the supported keys.',
  '- Each value must be a full URL string. Do NOT put labels like "LinkedIn" as the value — only the URL.',
].join('\n');

const buildUserPrompt = (cvText: string): string => {
  return [
    '<<<CV>>>',
    cvText,
    '<<<END CV>>>',
    '',
    'Return the structured JSON now.',
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CvParseError extends Error {
  /**
   * Categorical kind so the route can pick the right HTTP status without
   * having to string-match. Mirrors the conventions in `lib/llm.ts`.
   */
  kind:
    | 'extraction-failed'
    | 'extractor-no-text'
    | 'extractor-unsupported'
    | 'llm-quota'
    | 'llm-policy'
    | 'llm-invalid'
    | 'llm-transient'
    | 'llm-not-configured'
    | 'llm-unknown';
  cause?: unknown;

  constructor(kind: CvParseError['kind'], message: string, cause?: unknown) {
    super(message);
    this.name = 'CvParseError';
    this.kind = kind;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface ParseCvArgs {
  /** Raw file bytes (PDF or DOCX). */
  bytes: Uint8Array;
  /** Storage extension we recorded at upload time. */
  format: CvExtractFormat;
}

/**
 * Run the full bytes → structured-JSON pipeline.
 *
 * Errors are funnelled through `CvParseError` with a typed `kind`. The
 * route layer pattern-matches on `kind` to pick HTTP status code.
 */
export async function parseCv(args: ParseCvArgs): Promise<CvParseEnvelope> {
  // 1. Bytes → text. Distinct error types so the route can return
  //    different status codes for "unsupported format" (415-ish) vs
  //    "we couldn't read anything" (422-ish).
  let extracted: Awaited<ReturnType<typeof extractCvText>>;
  try {
    extracted = await extractCvText(args.bytes, args.format);
  } catch (err) {
    if (err instanceof CvExtractionError) {
      switch (err.kind) {
        case 'unsupported-format':
          throw new CvParseError('extractor-unsupported', err.message, err);
        case 'no-text':
          throw new CvParseError('extractor-no-text', err.message, err);
        case 'corrupt':
        case 'too-large':
          throw new CvParseError('extraction-failed', err.message, err);
      }
    }
    throw new CvParseError(
      'extraction-failed',
      'Failed to read text from the CV.',
      err,
    );
  }

  // 2. Text → structured JSON via Gemini.
  let llmResult: Awaited<ReturnType<typeof generateStructured<CvParseResult>>>;
  try {
    llmResult = await generateStructured<CvParseResult>({
      systemInstruction: SYSTEM_INSTRUCTION,
      userPrompt: buildUserPrompt(extracted.text),
      schema: cvParseSchema,
      // Light validation: ensure we got an object back. The schema
      // guarantees the shape, so the heavy lifting is already done.
      validate: (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Expected a JSON object at the top level.');
        }
        return parsed as CvParseResult;
      },
    });
  } catch (err) {
    if (err instanceof LlmError) {
      switch (err.kind) {
        case 'quota':
          throw new CvParseError('llm-quota', err.message, err);
        case 'content-policy':
          throw new CvParseError('llm-policy', err.message, err);
        case 'invalid-response':
          throw new CvParseError('llm-invalid', err.message, err);
        case 'transient':
          throw new CvParseError('llm-transient', err.message, err);
        case 'not-configured':
          throw new CvParseError('llm-not-configured', err.message, err);
        case 'unknown':
          throw new CvParseError('llm-unknown', err.message, err);
      }
    }
    throw new CvParseError('llm-unknown', 'Unexpected error during AI parse.', err);
  }

  return {
    data: llmResult.data,
    usage: llmResult.usage,
    modelUsed: llmResult.modelUsed,
    provider: llmResult.provider,
    inputTruncated: extracted.truncated,
    inputBytes: extracted.bytes,
  };
}
