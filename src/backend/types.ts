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

/** Outcome of several requests sent in order on one WebSocket context. */
export interface StreamedPieces {
  requestIds: string[];
  /** Bytes of audio delivered, across every piece. */
  bytes: number;
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
   * Sends every piece, in order, on one WebSocket context, handing each chunk
   * of audio to `onAudio` as it arrives (and waiting for it, so a slow writer
   * slows the reading rather than buffering). `output_format.container` must
   * be `raw`.
   */
  streamPieces(
    pieces: readonly string[],
    params: Omit<SynthesisParams, 'text'>,
    onAudio: (chunk: Uint8Array) => Promise<void>,
    options?: CallOptions,
  ): Promise<StreamedPieces>;
}

/** What a failed call looked like, for turning into a tool error. */
export interface BackendErrorInfo {
  /** The SDK error class name, e.g. `InsufficientCreditsError`, or `ServerShuttingDown`. */
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
  /**
   * A client for an API key already known to be valid. Implementations keep
   * one per key to reuse connections, and never close one with calls running.
   */
  client(apiKey: string): TtsClient;
  /**
   * Checks a key with `GET /v1/voices` (free) on a one-off client that is not
   * kept, so unverified keys never occupy a slot. Resolves with the voices;
   * rejects with the API's error (e.g. 401 for a wrong key).
   */
  checkKey(apiKey: string): Promise<Voice[]>;
  /** The SDK's sentence segmenter, with pieces of at most `maxChars` code points. */
  splitSentences(text: string, maxChars: number): string[];
  /** Wraps raw mono PCM (or G.711) in a WAV header. */
  toWav(audio: Uint8Array, encoding: Encoding, sampleRate: number): Uint8Array;
  /** Describes an error thrown by `TtsClient`; undefined for anything that is not a Bakbak error. */
  describeError(error: unknown): BackendErrorInfo | undefined;
  /** The API base URL in use (for error messages). */
  readonly baseURL: string;
  /** Stops every client; calls still running fail with a `ServerShuttingDown` error. */
  close(): Promise<void>;
}
