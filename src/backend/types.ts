/**
 * The small surface the MCP tools need from Bakbak. The production
 * implementation (`./sdk.ts`) sits on the official `bakbak` JS SDK; keeping the
 * tools behind this interface keeps them independent of SDK details.
 *
 * Field names are the API's wire names (snake_case), as everywhere in Bakbak.
 */

/** Languages the API knows today. The type stays open: a new language needs no release. */
export const KNOWN_LANGUAGES = [
  'hi',
  'mr',
  'te',
  'kn',
  'bn',
  'as',
  'gu',
  'ne',
  'ml',
  'ta',
  'pa',
  'en',
  'en-in',
  'en-us',
] as const;

export type KnownLanguage = (typeof KNOWN_LANGUAGES)[number];
export type Language = KnownLanguage | (string & {});

export const KNOWN_MODELS = ['standard', 'm1'] as const;
export type Model = (typeof KNOWN_MODELS)[number] | (string & {});

export const KNOWN_CONTAINERS = ['wav', 'mp3', 'raw'] as const;
export type Container = (typeof KNOWN_CONTAINERS)[number] | (string & {});

export const KNOWN_ENCODINGS = ['pcm_s16le', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw'] as const;
export type Encoding = (typeof KNOWN_ENCODINGS)[number] | (string & {});

export const KNOWN_SAMPLE_RATES = [8000, 16000, 22050, 24000] as const;

/** The API's `output_format` object. */
export interface OutputFormat {
  container: Container;
  encoding?: Encoding | undefined;
  sample_rate?: number | undefined;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  model: string;
}

/** One synthesis request, in wire names. */
export interface SynthesisParams {
  text: string;
  voice_id: string;
  language: Language;
  model?: Model | undefined;
  speed?: number | undefined;
  output_format: OutputFormat;
}

/** A whole-file response. */
export interface SynthesizedAudio {
  data: Uint8Array;
  requestId: string | undefined;
  /** The response's `Content-Type`, when present. */
  contentType: string | undefined;
}

/** Audio of several requests sent in order on one WebSocket context. */
export interface StreamedPieces {
  /** Raw audio of every piece, concatenated in order. */
  audio: Uint8Array;
  requestIds: string[];
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** Called after each piece of a multi-piece synthesis finishes (1-based). */
  onPieceDone?: ((done: number, total: number) => void) | undefined;
}

/** Bakbak, as seen with one API key. */
export interface TtsClient {
  listVoices(options?: CallOptions): Promise<Voice[]>;
  /** `POST /v1/text-to-speech`: one request, the whole file. */
  generate(params: SynthesisParams, options?: CallOptions): Promise<SynthesizedAudio>;
  /**
   * Sends every piece, in order, on one WebSocket context, and returns their
   * audio concatenated. `params.output_format.container` must be `raw`.
   */
  streamPieces(
    pieces: readonly string[],
    params: Omit<SynthesisParams, 'text'>,
    options?: CallOptions,
  ): Promise<StreamedPieces>;
}

/** What a failed call looked like, for turning into a tool error. */
export interface BackendErrorInfo {
  /** The SDK error class name, e.g. `InsufficientCreditsError`. */
  type: string;
  /** HTTP status (or the in-band `status_code`), when the service answered. */
  status: number | undefined;
  /** The API's `error_code`, never invented. */
  errorCode: string | undefined;
  message: string;
  retryable: boolean;
  requestId: string | undefined;
  /** Bytes of audio delivered before a stream broke. */
  audioBytes: number | undefined;
  /** True when no usable answer came back (network, DNS, TLS, timeout). */
  connection: boolean;
}

export interface Backend {
  /** A client for this key. Implementations reuse connections per key. */
  client(apiKey: string): TtsClient;
  /** The SDK's sentence segmenter, with pieces of at most `maxChars` code points. */
  splitSentences(text: string, maxChars: number): string[];
  /** Wraps raw mono PCM (or G.711) in a WAV header. */
  toWav(audio: Uint8Array, encoding: Encoding, sampleRate: number): Uint8Array;
  /** Describes an error thrown by `TtsClient`; undefined for anything that is not a Bakbak error. */
  describeError(error: unknown): BackendErrorInfo | undefined;
  /** The API base URL in use (for error messages). */
  readonly baseURL: string;
  close(): Promise<void>;
}
