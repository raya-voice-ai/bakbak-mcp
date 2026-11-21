/**
 * Turns text of any length (up to the tool's limit) into one audio file,
 * written to a sink as it arrives.
 *
 * - Text within one request's limit is one `generate` call, so the file is
 *   exactly what the API returned.
 * - Longer text is split with the SDK's sentence segmenter and packed into
 *   pieces of at most one request's limit. Raw and WAV output stream every
 *   piece over one WebSocket context as raw PCM, straight to the sink; WAV
 *   gets a header first whose sizes are filled in at the end. MP3 output
 *   (which the stream endpoints do not offer) makes one `generate` call per
 *   piece and joins the MP3 frames.
 */

import type {
  Backend,
  CallOptions,
  OutputFormat,
  SynthesisParams,
  TtsClient,
} from '../backend/types.js';
import { codePointLength } from '../util.js';
import {
  DEFAULT_SAMPLE_RATE,
  audioDuration,
  bytesPerSample,
  id3v2Length,
  mp3Duration,
  parseWav,
  patchWavHeader,
} from './format.js';
import type { AudioSink } from './sink.js';

/** The API's limit on one request's `text`, in code points. */
export const MAX_REQUEST_CHARS = 5000;

export interface SynthesisResult {
  requestIds: string[];
  /** Number of API requests the text needed. */
  pieces: number;
  /** Seconds of audio written. */
  durationSeconds: number;
}

/** Raised for input this module cannot synthesize; the message is meant for the caller. */
export class SynthesisInputError extends Error {
  override readonly name: string = 'SynthesisInputError';
}

/**
 * The API answered an mp3 request with WAV audio (as the `standard` model
 * does), so the pieces of a long text cannot be joined into one MP3.
 */
export class Mp3UnavailableError extends SynthesisInputError {
  override readonly name = 'Mp3UnavailableError';
  constructor(model: string | undefined) {
    super(
      `MP3 is not available for long text with the ${model ?? 'standard'} model: the API returned WAV audio for an mp3 request, and WAV pieces cannot be joined under an MP3 label.`,
    );
  }
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
  sink: AudioSink,
  options: CallOptions,
): Promise<SynthesisResult> {
  const requestIds: string[] = [];
  let seconds = 0;
  for (const [index, text] of pieces.entries()) {
    const audio = await client.generate({ ...params, text }, options);
    if (parseWav(audio.data)) throw new Mp3UnavailableError(params.model);
    // Later pieces' ID3 tags would sit mid-stream; players expect at most one, at the start.
    await sink.write(index === 0 ? audio.data : audio.data.subarray(id3v2Length(audio.data)));
    seconds += mp3Duration(audio.data);
    if (audio.requestId) requestIds.push(audio.requestId);
    options.onPieceDone?.(index + 1, pieces.length);
  }
  return { requestIds, pieces: pieces.length, durationSeconds: seconds };
}

export async function synthesize(
  backend: Backend,
  client: TtsClient,
  params: SynthesisParams,
  sink: AudioSink,
  options: CallOptions = {},
): Promise<SynthesisResult> {
  const format = params.output_format;
  if (codePointLength(params.text) <= MAX_REQUEST_CHARS) {
    const audio = await client.generate(params, options);
    await sink.write(audio.data);
    return {
      requestIds: audio.requestId ? [audio.requestId] : [],
      pieces: 1,
      durationSeconds: audioDuration(audio.data, format),
    };
  }

  const pieces = packSentences(
    backend.splitSentences(params.text, MAX_REQUEST_CHARS),
    MAX_REQUEST_CHARS,
  );
  const { text: _text, ...rest } = params;
  if (format.container === 'mp3') return generateEach(client, pieces, rest, sink, options);

  if (format.container !== 'wav' && format.container !== 'raw') {
    throw new SynthesisInputError(
      `Text over ${MAX_REQUEST_CHARS} characters can be assembled only as wav, raw or mp3, not "${format.container}".`,
    );
  }
  const encoding = format.encoding;
  const sampleSize = bytesPerSample(encoding);
  if (encoding === undefined || sampleSize === undefined) {
    throw new SynthesisInputError(
      `output_format.encoding must be pcm_s16le, pcm_f32le, pcm_mulaw or pcm_alaw to join long ${format.container} audio.`,
    );
  }
  const sampleRate = format.sample_rate ?? DEFAULT_SAMPLE_RATE;
  const rawFormat: OutputFormat = { container: 'raw', encoding, sample_rate: format.sample_rate };
  // WAV: a header now (sizes still zero), the samples as they arrive, the real sizes at the end.
  const header =
    format.container === 'wav' ? backend.toWav(new Uint8Array(0), encoding, sampleRate) : undefined;
  if (header) await sink.write(header);
  const streamed = await client.streamPieces(
    pieces,
    { ...rest, output_format: rawFormat },
    (chunk) => sink.write(chunk),
    options,
  );
  if (header) await sink.writeAt(patchWavHeader(header, streamed.bytes), 0);
  return {
    requestIds: streamed.requestIds,
    pieces: pieces.length,
    durationSeconds: streamed.bytes / sampleSize / sampleRate,
  };
}
