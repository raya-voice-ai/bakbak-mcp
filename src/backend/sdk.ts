/**
 * The production backend, on the official `bakbak` JS SDK.
 *
 * One SDK client per valid API key is kept so HTTP connections and the
 * WebSocket are reused across tool calls. The set is bounded, but a client
 * with calls in flight is never evicted, and unverified keys never get a slot:
 * they are checked on a one-off client (`checkKey`).
 */

import {
  APIConnectionError,
  Bakbak,
  BakbakError,
  StreamInterruptedError,
  type TTSParams,
  type TTSWebSocket,
  VERSION as SDK_VERSION,
  splitSentences,
  toWav,
} from 'bakbak';

import type { Logger } from '../log.js';
import { fingerprint } from '../util.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import type {
  Backend,
  BackendErrorInfo,
  CallOptions,
  Encoding,
  StreamedPieces,
  SynthesisParams,
  SynthesizedAudio,
  TtsClient,
  Voice,
} from './types.js';

/** The API's production base URL (BEHAVIOR.md §1). */
export const DEFAULT_BASE_URL = 'https://hub.getraya.app';

export interface SdkBackendOptions {
  /** API base URL; defaults to `https://hub.getraya.app`. */
  baseURL?: string | undefined;
  logger: Logger;
  /** Most idle per-key clients kept at once (hosted mode serves many keys). */
  maxClients?: number;
  /** An idle client unused this long is closed. */
  idleMs?: number;
}

/** Raised for calls stopped because the server is shutting down. */
export class ServerShuttingDownError extends Error {
  override readonly name = 'ServerShuttingDown';
  constructor() {
    super('This server is shutting down, so the call was stopped before the audio was finished.');
  }
}

function wireParams(params: Omit<SynthesisParams, 'text'>): Omit<TTSParams, 'text'> {
  return {
    voice_id: params.voice_id,
    language: params.language,
    ...(params.model !== undefined && { model: params.model }),
    ...(params.speed !== undefined && { speed: params.speed }),
    output_format: {
      container: params.output_format.container,
      ...(params.output_format.encoding !== undefined && {
        encoding: params.output_format.encoding,
      }),
      ...(params.output_format.sample_rate !== undefined && {
        sample_rate: params.output_format.sample_rate,
      }),
    },
  };
}

function toVoices(list: {
  voices: { id: string; name: string; language: string; model: string }[];
}): Voice[] {
  return list.voices.map((v) => ({ id: v.id, name: v.name, language: v.language, model: v.model }));
}

class SdkClient implements TtsClient {
  lastUsed = Date.now();
  /** Calls in flight; a client with any is never evicted. */
  active = 0;
  private closed = false;
  private socket: TTSWebSocket | undefined;

  constructor(private readonly sdk: Bakbak) {}

  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.active++;
    this.lastUsed = Date.now();
    try {
      return await work();
    } catch (error) {
      throw this.closed ? new ServerShuttingDownError() : error;
    } finally {
      this.active--;
      this.lastUsed = Date.now();
    }
  }

  listVoices(options: CallOptions = {}): Promise<Voice[]> {
    return this.track(async () =>
      toVoices(await this.sdk.voices.list(undefined, { signal: options.signal })),
    );
  }

  generate(params: SynthesisParams, options: CallOptions = {}): Promise<SynthesizedAudio> {
    return this.track(async () => {
      const audio = await this.sdk.tts.generate(
        { ...wireParams(params), text: params.text },
        { signal: options.signal },
      );
      return { data: audio.data, requestId: audio.requestId, contentType: audio.contentType };
    });
  }

  streamPieces(
    pieces: readonly string[],
    params: Omit<SynthesisParams, 'text'>,
    onAudio: (chunk: Uint8Array) => Promise<void>,
    options: CallOptions = {},
  ): Promise<StreamedPieces> {
    return this.track(async () => {
      this.socket ??= this.sdk.tts.websocket();
      const ctx = this.socket.context(wireParams(params));
      const { signal, onPieceDone } = options;
      signal?.throwIfAborted();

      // An object, not a `let`: it is flipped from callbacks the compiler cannot see.
      const state = { stopped: false };
      const sending = (async () => {
        try {
          for (const text of pieces) {
            if (state.stopped) break;
            await ctx.send({ text });
          }
        } finally {
          ctx.endInput();
        }
      })();
      sending.catch(() => undefined); // awaited below; never left unhandled

      const onAbort = (): void => {
        state.stopped = true;
        ctx.cancel().catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const requestIds: string[] = [];
      let bytes = 0;
      try {
        for await (const event of ctx.events()) {
          this.lastUsed = Date.now();
          if (event.type === 'chunk') {
            bytes += event.audio.byteLength;
            await onAudio(event.audio);
          } else if (event.type === 'done') {
            if (event.request.requestId) requestIds.push(event.request.requestId);
            onPieceDone?.(requestIds.length, pieces.length);
          } else if (event.type === 'failed') {
            throw event.error;
          } else {
            throw signal?.reason ?? new BakbakError('The synthesis was cancelled.');
          }
        }
        await sending;
      } catch (error) {
        // Stop the remaining pieces: their audio would be billed and thrown away.
        state.stopped = true;
        await ctx.cancel().catch(() => undefined);
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      return { requestIds, bytes };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    await socket?.close();
  }
}

/** Creates the SDK-backed {@link Backend}. */
export function createSdkBackend(options: SdkBackendOptions): Backend {
  const { logger } = options;
  const maxClients = options.maxClients ?? 500;
  const idleMs = options.idleMs ?? 15 * 60_000;
  const clients = new Map<string, SdkClient>();
  const sdkLogger = {
    debug: (message: string, fields?: Record<string, unknown>) => {
      logger.debug(`sdk: ${message}`, fields);
    },
    warn: (message: string, fields?: Record<string, unknown>) => {
      logger.warn(`sdk: ${message}`, fields);
    },
    error: (message: string, fields?: Record<string, unknown>) => {
      logger.error(`sdk: ${message}`, fields);
    },
  };
  const baseURL = (options.baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const defaultHeaders = {
    'X-Bakbak-Client': `${PACKAGE_NAME}/${VERSION} bakbak-js/${SDK_VERSION}`,
  };
  const make = (apiKey: string, maxRetries?: number): Bakbak =>
    new Bakbak({
      apiKey,
      baseURL,
      logger: sdkLogger,
      defaultHeaders,
      ...(maxRetries !== undefined && { maxRetries }),
    });

  const evict = (id: string, client: SdkClient): void => {
    clients.delete(id);
    client.close().catch((error: unknown) => {
      logger.debug('closing an idle client failed', { error });
    });
  };
  /** Drops idle clients, oldest first, while over the bound. Busy clients stay. */
  const trim = (): void => {
    for (const [id, client] of clients) {
      if (clients.size <= maxClients) break;
      if (client.active === 0) evict(id, client);
    }
  };
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, client] of clients) {
      if (client.active === 0 && client.lastUsed < cutoff) evict(id, client);
    }
  }, 60_000);
  sweeper.unref();

  return {
    baseURL,
    client(apiKey) {
      const id = fingerprint(apiKey);
      const client = clients.get(id) ?? new SdkClient(make(apiKey));
      clients.delete(id); // re-insert: Map order tracks recency
      clients.set(id, client);
      trim();
      return client;
    },
    async checkKey(apiKey) {
      // A one-off client: an unverified key must never take a slot in `clients`.
      return toVoices(await make(apiKey, 0).voices.list());
    },
    splitSentences(text, maxChars) {
      return splitSentences(text, { maxChars });
    },
    toWav(audio: Uint8Array, encoding: Encoding, sampleRate: number) {
      return toWav(audio, { encoding, sampleRate });
    },
    describeError(error): BackendErrorInfo | undefined {
      if (error instanceof ServerShuttingDownError) {
        return {
          type: error.name,
          status: undefined,
          errorCode: undefined,
          message: error.message,
          retryable: true,
          requestId: undefined,
          audioBytes: undefined,
          connection: false,
        };
      }
      if (!(error instanceof BakbakError)) return undefined;
      return {
        type: error.name,
        status: error.status,
        errorCode: error.errorCode,
        message: error.message,
        retryable: error.retryable,
        requestId: error.requestId,
        audioBytes: error instanceof StreamInterruptedError ? error.audioBytes : undefined,
        connection: error instanceof APIConnectionError,
      };
    },
    async close() {
      clearInterval(sweeper);
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(all.map((c) => c.close().catch(() => undefined)));
    },
  };
}
