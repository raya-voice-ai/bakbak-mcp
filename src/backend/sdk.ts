/**
 * The production backend, on the official `bakbak` JS SDK. One SDK client per
 * API key is kept (bounded, evicted when idle), so HTTP connections and the
 * WebSocket are reused across tool calls.
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
import { concatBytes, fingerprint } from '../util.js';
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
  /** API base URL; defaults to the SDK's (`https://hub.getraya.app`). */
  baseURL?: string | undefined;
  logger: Logger;
  /** Most per-key clients kept at once (hosted mode serves many keys). */
  maxClients?: number;
  /** A client unused this long is closed. */
  idleMs?: number;
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

class SdkClient implements TtsClient {
  lastUsed = Date.now();
  private socket: TTSWebSocket | undefined;

  constructor(private readonly sdk: Bakbak) {}

  async listVoices(options: CallOptions = {}): Promise<Voice[]> {
    this.lastUsed = Date.now();
    const list = await this.sdk.voices.list(undefined, { signal: options.signal });
    return list.voices.map((v) => ({
      id: v.id,
      name: v.name,
      language: v.language,
      model: v.model,
    }));
  }

  async generate(params: SynthesisParams, options: CallOptions = {}): Promise<SynthesizedAudio> {
    this.lastUsed = Date.now();
    const audio = await this.sdk.tts.generate(
      { ...wireParams(params), text: params.text },
      { signal: options.signal },
    );
    return { data: audio.data, requestId: audio.requestId, contentType: audio.contentType };
  }

  async streamPieces(
    pieces: readonly string[],
    params: Omit<SynthesisParams, 'text'>,
    options: CallOptions = {},
  ): Promise<StreamedPieces> {
    this.lastUsed = Date.now();
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
    const parts: Uint8Array[] = [];
    const requestIds: string[] = [];
    try {
      for await (const event of ctx.events()) {
        this.lastUsed = Date.now();
        if (event.type === 'chunk') {
          parts.push(event.audio);
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
    return { audio: concatBytes(parts), requestIds };
  }

  async close(): Promise<void> {
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
  const make = (apiKey: string): Bakbak =>
    new Bakbak({
      apiKey,
      baseURL,
      logger: sdkLogger,
      defaultHeaders: { 'X-Bakbak-Client': `${PACKAGE_NAME}/${VERSION} bakbak-js/${SDK_VERSION}` },
    });

  const evict = (id: string, client: SdkClient): void => {
    clients.delete(id);
    client.close().catch((error: unknown) => {
      logger.debug('closing an idle client failed', { error });
    });
  };
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, client] of clients) {
      if (client.lastUsed < cutoff) evict(id, client);
    }
  }, 60_000);
  sweeper.unref();

  return {
    baseURL,
    client(apiKey) {
      const id = fingerprint(apiKey);
      let client = clients.get(id);
      if (client) {
        clients.delete(id); // re-insert: Map order tracks recency
      } else {
        client = new SdkClient(make(apiKey));
      }
      clients.set(id, client);
      for (const [oldestId, oldest] of clients) {
        if (clients.size <= maxClients) break;
        evict(oldestId, oldest);
      }
      return client;
    },
    splitSentences(text, maxChars) {
      return splitSentences(text, { maxChars });
    },
    toWav(audio: Uint8Array, encoding: Encoding, sampleRate: number) {
      return toWav(audio, { encoding, sampleRate });
    },
    describeError(error): BackendErrorInfo | undefined {
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
