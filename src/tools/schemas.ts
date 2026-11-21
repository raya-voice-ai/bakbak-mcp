/**
 * Tool input and output schemas. Parameter names are the API's wire names.
 * Enumerations are open (known values, or any string) so a new language,
 * model or encoding works without a release; the API validates values.
 * Objects are strict: an unknown argument, such as an API key, is refused.
 */

import * as z from 'zod';

import {
  KNOWN_CONTAINERS,
  KNOWN_ENCODINGS,
  KNOWN_LANGUAGES,
  KNOWN_MODELS,
} from '../backend/types.js';
import { codePointLength } from '../util.js';

/** The most text one `text_to_speech` call accepts, in code points. */
export const MAX_TOOL_TEXT_CHARS = 50_000;

/** The largest audio returned inline when `include_audio` is set. */
export const MAX_INLINE_AUDIO_BYTES = 1024 * 1024;

export const DEFAULT_VOICE_LIMIT = 50;
export const MAX_VOICE_LIMIT = 500;

function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([z.enum(values), z.string().min(1)]);
}

const language = openEnum(KNOWN_LANGUAGES);
const model = openEnum(KNOWN_MODELS);

export const outputFormatSchema = z
  .strictObject({
    container: openEnum(KNOWN_CONTAINERS).describe(
      'wav (default), mp3, or raw (headerless samples).',
    ),
    encoding: openEnum(KNOWN_ENCODINGS)
      .optional()
      .describe('Sample encoding. Required for wav and raw; omit for mp3.'),
    sample_rate: z
      .number()
      .optional()
      .describe('Samples per second: 8000, 16000, 22050 or 24000 (the default).'),
  })
  .refine((f) => !((f.container === 'wav' || f.container === 'raw') && f.encoding === undefined), {
    message:
      'output_format.encoding is required for wav and raw: pcm_s16le, pcm_f32le, pcm_mulaw or pcm_alaw',
    path: ['encoding'],
  })
  .describe(
    'The API output_format object. Default {"container":"wav","encoding":"pcm_s16le","sample_rate":24000}.',
  );

const ttsBase = {
  text: z
    .string()
    .min(1)
    .refine((t) => codePointLength(t) <= MAX_TOOL_TEXT_CHARS, {
      message: `text must be at most ${MAX_TOOL_TEXT_CHARS} characters`,
    })
    .meta({ maxLength: MAX_TOOL_TEXT_CHARS })
    .describe(
      'The text to speak, up to 50,000 characters. Hindi must be in Devanagari script; Indian names in English text are best written in Devanagari.',
    ),
  language: language.describe(
    'Language of the text: hi, mr, te, kn, bn, as, gu, ne, ml, ta, pa, en, en-in or en-us. English m1 voices use en; standard English voices use en-in or en-us.',
  ),
  voice_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A voice id from list_voices. If omitted, the first voice for the language (and model, if given) is used.',
    ),
  model: model
    .optional()
    .describe(
      "standard or m1. Must be the voice's model; if omitted, the chosen voice's own model is used.",
    ),
  speed: z.number().optional().describe('Speaking rate from 0.5 to 1.5 (default 1.0).'),
  output_format: outputFormatSchema.optional(),
  include_audio: z
    .boolean()
    .default(false)
    .describe(
      'Also return the audio inline as an audio content block. Only for audio up to 1 MB (about 20 s of the default WAV).',
    ),
};

/** `text_to_speech` arguments in local (stdio) mode. */
export const localTtsInput = z.strictObject({
  ...ttsBase,
  output_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Where to save the file: an absolute path, or a path relative to the output directory. Its directory must exist and its extension must match the format. Default: a new file in the output directory.',
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      'Replace output_path if it already exists. Without it, an existing file is never touched.',
    ),
});

/** `text_to_speech` arguments in hosted (HTTP) mode: no file paths. */
export const hostedTtsInput = z.strictObject(ttsBase);

export type LocalTtsArgs = z.infer<typeof localTtsInput>;
export type HostedTtsArgs = z.infer<typeof hostedTtsInput>;
export type TtsArgs = HostedTtsArgs & Partial<Pick<LocalTtsArgs, 'output_path' | 'overwrite'>>;

const formatOutput = z.object({
  container: z.string(),
  encoding: z.string().optional(),
  sample_rate: z.number().optional(),
  mime_type: z.string(),
});

const ttsOutputBase = {
  format: formatOutput,
  duration_seconds: z.number().describe('Length of the audio in seconds.'),
  characters: z.number().int().describe('Characters of text synthesized (code points).'),
  voice_id: z.string(),
  model: z.string(),
  language: z.string(),
  request_ids: z.array(z.string()).describe('Bakbak request ids, for support.'),
};

export const localTtsOutput = z.object({
  file_path: z.string().describe('Absolute path of the saved audio file.'),
  ...ttsOutputBase,
});

export const hostedTtsOutput = z.object({
  audio_url: z
    .string()
    .describe(
      'Download link for the audio. Private; anyone with the link can download it until it expires.',
    ),
  expires_at: z.string().describe('When the link stops working (ISO 8601, UTC).'),
  ...ttsOutputBase,
});

export type LocalTtsOutput = z.infer<typeof localTtsOutput>;
export type HostedTtsOutput = z.infer<typeof hostedTtsOutput>;

export const listVoicesInput = z.strictObject({
  language: language.optional().describe('Only voices for this language, e.g. hi.'),
  model: model.optional().describe('Only voices of this model: standard or m1.'),
  query: z
    .string()
    .optional()
    .describe('Only voices whose name contains this text (case-insensitive).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_VOICE_LIMIT)
    .default(DEFAULT_VOICE_LIMIT)
    .describe('Maximum number of voices to return (default 50).'),
});

export type ListVoicesArgs = z.infer<typeof listVoicesInput>;

export const listVoicesOutput = z.object({
  voices: z.array(
    z.object({ id: z.string(), name: z.string(), language: z.string(), model: z.string() }),
  ),
  count: z.number().int().describe('Voices returned.'),
  total: z.number().int().describe('Voices matching the filters, before the limit.'),
});

export type ListVoicesOutput = z.infer<typeof listVoicesOutput>;
