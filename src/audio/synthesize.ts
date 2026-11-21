/**
 * Turns text of any length (up to the tool's limit) into one audio file.
 *
 * - Text within one request's limit is one `generate` call, so the file is
 *   exactly what the API returned.
 * - Longer text is split with the SDK's sentence segmenter and packed into
 *   pieces of at most one request's limit. Raw and WAV output stream every
 *   piece over one WebSocket context as raw PCM, then write one WAV header
 *   over the concatenated samples. MP3 output (which the stream endpoints do
 *   not offer) makes one `generate` call per piece and joins the MP3 frames.
 */

import type {
  Backend,
  CallOptions,
  OutputFormat,
  SynthesisParams,
  TtsClient,
} from '../backend/types.js';
import { codePointLength, concatBytes } from '../util.js';
import { DEFAULT_SAMPLE_RATE, id3v2Length } from './format.js';

/** The API's limit on one request's `text`, in code points. */
export const MAX_REQUEST_CHARS = 5000;

export interface SynthesisResult {
  data: Uint8Array;
  requestIds: string[];
  /** Number of API requests the text needed. */
  pieces: number;
}

/** Raised for input this module cannot synthesize; the message is meant for the caller. */
export class SynthesisInputError extends Error {
  override readonly name = 'SynthesisInputError';
}

/**
 * Greedily joins consecutive sentences (with one space) into pieces of at most
 * `maxChars` code points. A sentence is never split here: the segmenter has
 * already wrapped any sentence longer than `maxChars`.
 */
export function packSentences(sentences: readonly string[], maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let currentLength = 0;
  for (const sentence of sentences) {
    const length = codePointLength(sentence);
    if (currentLength > 0 && currentLength + 1 + length <= maxChars) {
      current += ' ' + sentence;
      currentLength += 1 + length;
    } else {
      if (currentLength > 0) pieces.push(current);
      current = sentence;
      currentLength = length;
    }
  }
  if (currentLength > 0) pieces.push(current);
  return pieces;
}

async function generateEach(
  client: TtsClient,
  pieces: readonly string[],
  params: Omit<SynthesisParams, 'text'>,
  options: CallOptions,
): Promise<SynthesisResult> {
  const parts: Uint8Array[] = [];
  const requestIds: string[] = [];
  for (const [index, text] of pieces.entries()) {
    const audio = await client.generate({ ...params, text }, options);
    // Later pieces' ID3 tags would sit mid-stream; players expect at most one, at the start.
    parts.push(index === 0 ? audio.data : audio.data.subarray(id3v2Length(audio.data)));
    if (audio.requestId) requestIds.push(audio.requestId);
    options.onPieceDone?.(index + 1, pieces.length);
  }
  return { data: concatBytes(parts), requestIds, pieces: pieces.length };
}

export async function synthesize(
  backend: Backend,
  client: TtsClient,
  params: SynthesisParams,
  options: CallOptions = {},
): Promise<SynthesisResult> {
  if (codePointLength(params.text) <= MAX_REQUEST_CHARS) {
    const audio = await client.generate(params, options);
    return {
      data: audio.data,
      requestIds: audio.requestId ? [audio.requestId] : [],
      pieces: 1,
    };
  }

  const pieces = packSentences(
    backend.splitSentences(params.text, MAX_REQUEST_CHARS),
    MAX_REQUEST_CHARS,
  );
  const { text: _text, ...rest } = params;
  const format = params.output_format;
  if (format.container === 'mp3') return generateEach(client, pieces, rest, options);

  if (format.container !== 'wav' && format.container !== 'raw') {
    throw new SynthesisInputError(
      `Text over ${MAX_REQUEST_CHARS} characters can be assembled only as wav, raw or mp3, not "${format.container}".`,
    );
  }
  const encoding = format.encoding;
  if (encoding === undefined) {
    throw new SynthesisInputError(
      `output_format.encoding is required for ${format.container} output (for example "pcm_s16le").`,
    );
  }
  const sampleRate = format.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const rawFormat: OutputFormat = { container: 'raw', encoding, sample_rate: format.sample_rate };
  const streamed = await client.streamPieces(
    pieces,
    { ...rest, output_format: rawFormat },
    options,
  );
  return {
    data:
      format.container === 'wav'
        ? backend.toWav(streamed.audio, encoding, sampleRate)
        : streamed.audio,
    requestIds: streamed.requestIds,
    pieces: pieces.length,
  };
}
