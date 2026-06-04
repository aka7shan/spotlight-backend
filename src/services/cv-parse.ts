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
  Type as GenAiType,
  type Schema as GenAiSchema,
} from '@google/genai';

import {
  CvExtractionError,
  extractCvText,
  type CvExtractFormat,
} from '../lib/cv-extract.js';
import {
  generateStructured,
  LlmError,
  type LlmUsage,
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
// JSON schema for Gemini (mirrors CvParseResult)
// ---------------------------------------------------------------------------
//
// Gemini will *enforce* this at decode time, so it's our load-bearing
// contract — not just hints. A few deliberate choices:
//
//  - Everything optional. Empty CVs and short ones must produce valid
//    output without the model inventing data.
//  - Enums encoded with `enum:` so the model can't return "completed"
//    when we want "Completed" (the wire shape is case-sensitive).
//  - `format: 'email'` etc. is NOT used — real CVs sometimes have
//    valid emails the spec rejects (subaddressing with `+`, etc.).
//    We accept whatever and let the frontend validator catch the rest.
//  - No `description` field on the schema itself — Gemini doesn't read
//    those at runtime. All hints live in the system prompt below.

const cvParseSchema: GenAiSchema = {
  type: GenAiType.OBJECT,
  properties: {
    name: { type: GenAiType.STRING },
    title: { type: GenAiType.STRING },
    email: { type: GenAiType.STRING },
    phone: { type: GenAiType.STRING },
    location: { type: GenAiType.STRING },
    about: { type: GenAiType.STRING },

    socialLinks: {
      type: GenAiType.OBJECT,
      properties: {
        linkedin: { type: GenAiType.STRING },
        github: { type: GenAiType.STRING },
        twitter: { type: GenAiType.STRING },
        website: { type: GenAiType.STRING },
        dribbble: { type: GenAiType.STRING },
        behance: { type: GenAiType.STRING },
      },
    },

    skills: {
      type: GenAiType.ARRAY,
      items: { type: GenAiType.STRING },
    },

    experience: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          position: { type: GenAiType.STRING },
          company: { type: GenAiType.STRING },
          startDate: { type: GenAiType.STRING },
          endDate: { type: GenAiType.STRING },
          isPresent: { type: GenAiType.BOOLEAN },
          description: { type: GenAiType.STRING },
          location: { type: GenAiType.STRING },
          skills: {
            type: GenAiType.ARRAY,
            items: { type: GenAiType.STRING },
          },
        },
        required: ['position', 'company', 'startDate'],
      },
    },

    education: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          degree: { type: GenAiType.STRING },
          institution: { type: GenAiType.STRING },
          startDate: { type: GenAiType.STRING },
          endDate: { type: GenAiType.STRING },
          isPresent: { type: GenAiType.BOOLEAN },
          gpa: { type: GenAiType.STRING },
          description: { type: GenAiType.STRING },
          achievements: {
            type: GenAiType.ARRAY,
            items: { type: GenAiType.STRING },
          },
        },
        required: ['degree', 'institution', 'startDate'],
      },
    },

    projects: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          name: { type: GenAiType.STRING },
          description: { type: GenAiType.STRING },
          tags: {
            type: GenAiType.ARRAY,
            items: { type: GenAiType.STRING },
          },
          link: { type: GenAiType.STRING },
          githubLink: { type: GenAiType.STRING },
          status: {
            type: GenAiType.STRING,
            enum: ['Completed', 'In Progress', 'Planned'],
          },
          startDate: { type: GenAiType.STRING },
          endDate: { type: GenAiType.STRING },
          role: { type: GenAiType.STRING },
          technologies: {
            type: GenAiType.ARRAY,
            items: { type: GenAiType.STRING },
          },
          achievements: {
            type: GenAiType.ARRAY,
            items: { type: GenAiType.STRING },
          },
        },
        required: ['name', 'description', 'status'],
      },
    },

    certifications: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          name: { type: GenAiType.STRING },
          issuer: { type: GenAiType.STRING },
          startDate: { type: GenAiType.STRING },
          endDate: { type: GenAiType.STRING },
          isPresent: { type: GenAiType.BOOLEAN },
          credentialId: { type: GenAiType.STRING },
          link: { type: GenAiType.STRING },
          expiryDate: { type: GenAiType.STRING },
        },
        required: ['name', 'issuer', 'startDate'],
      },
    },

    achievements: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          title: { type: GenAiType.STRING },
          description: { type: GenAiType.STRING },
          startDate: { type: GenAiType.STRING },
          organization: { type: GenAiType.STRING },
          link: { type: GenAiType.STRING },
        },
        required: ['title', 'startDate'],
      },
    },

    languages: {
      type: GenAiType.ARRAY,
      items: {
        type: GenAiType.OBJECT,
        properties: {
          name: { type: GenAiType.STRING },
          level: {
            type: GenAiType.STRING,
            enum: ['Beginner', 'Intermediate', 'Advanced', 'Fluent', 'Native', 'Expert'],
          },
          certification: { type: GenAiType.STRING },
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
  'Rules:',
  '1. Extract ONLY information explicitly present in the CV. Never invent fields.',
  '2. If a field is not in the CV, omit it from the output (do not return empty strings or placeholder values).',
  '3. Output strict JSON — no markdown, no commentary, no surrounding prose.',
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
  '- One entry per job. `description` is a short paragraph (or 2–4 bullet points joined by newlines). DO NOT prefix with "•" — preserve them only if the CV uses them.',
  '- `skills` here is per-role: technologies/tools mentioned for that specific job.',
  '',
  'Skills (top-level):',
  '- A flat array of distinct technologies, tools, and methodologies. Deduplicate. Preserve original casing ("React", "PostgreSQL").',
  '',
  'Projects:',
  '- Include only when the CV has a dedicated Projects section, or when the section is clearly "personal/side projects" distinct from employment.',
  '- `status` defaults to "Completed" unless the CV explicitly says otherwise.',
  '',
  'Languages:',
  '- Map proficiency claims to one of: Beginner, Intermediate, Advanced, Fluent, Native, Expert. If the CV says "Conversational", choose Intermediate. "Working proficiency" → Advanced. "Mother tongue" → Native.',
  '',
  'Social links:',
  '- Look for LinkedIn, GitHub, Twitter/X, personal website, Dribbble, Behance. Use full URLs ("https://github.com/foo"); if the CV gives a username only, expand to the canonical URL.',
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
    inputTruncated: extracted.truncated,
    inputBytes: extracted.bytes,
  };
}
