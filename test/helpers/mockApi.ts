/**
 * A mock Bakbak API on a random local port: `GET /v1/voices`,
 * `POST /v1/text-to-speech`, `POST /v1/text-to-speech/stream` and the
 * WebSocket at `/v1/text-to-speech/ws`, with the API's error shapes.
 *
 * Audio is deterministic: every request yields `SAMPLES_PER_CHAR` samples per
 * code point of text, each sample holding the request's 1-based sequence
 * number, so tests can check both length and the order pieces were joined in.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { codePointLength as codePoints } from '../../src/util.js';

export const TEST_KEY = 'test-key';
export const SAMPLES_PER_CHAR = 24; // 1 ms of audio per character at 24 kHz

export const VOICES = [
  { id: 'v-hi-std-1', name: 'Kavya', language: 'hi', model: 'standard' },
  { id: 'v-hi-std-2', name: 'Arjun', language: 'hi', model: 'standard' },
  { id: '009ae8b5-4a03-492d-af1c-3055989ac734', name: 'Anika M1', language: 'en', model: 'm1' },
  { id: 'v-hi-m1', name: 'Meera M1', language: 'hi', model: 'm1' },
  { id: 'v-ta-std', name: 'Tamil Voice', language: 'ta', model: 'standard' },
];

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | undefined;
  /** For WebSocket messages. */
  transport: 'http' | 'ws';
}

export interface MockErrorResponse {
  status: number;
  json: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type Interceptor = (request: RecordedRequest) => MockErrorResponse | undefined;

interface OutputFormat {
  container?: string;
  encoding?: string;
  sample_rate?: number;
}

const BYTES: Record<string, number> = { pcm_s16le: 2, pcm_f32le: 4, pcm_mulaw: 1, pcm_alaw: 1 };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Raw samples for one request: `chars * SAMPLES_PER_CHAR` samples of value `seq`. */
export function pcmFor(chars: number, seq: number, encoding = 'pcm_s16le'): Buffer {
  const count = chars * SAMPLES_PER_CHAR;
  const size = BYTES[encoding] ?? 2;
  const buf = Buffer.alloc(count * size);
  for (let i = 0; i < count; i++) {
    if (size === 2) buf.writeInt16LE(seq, i * 2);
    else if (size === 4) buf.writeFloatLE(seq / 1000, i * 4);
    else buf.writeUInt8(seq & 0xff, i);
  }
  return buf;
}

export function wavHeader(dataBytes: number, sampleRate: number, encoding = 'pcm_s16le'): Buffer {
  const size = BYTES[encoding] ?? 2;
  const format =
    encoding === 'pcm_f32le' ? 3 : encoding === 'pcm_alaw' ? 6 : encoding === 'pcm_mulaw' ? 7 : 1;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * size, 28);
  h.writeUInt16LE(size, 32);
  h.writeUInt16LE(size * 8, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Valid MPEG-1 Layer III frames (128 kbps, 44.1 kHz, 1152 samples each), one per 10 characters. */
export function mp3For(chars: number, withId3 = true): Buffer {
  const frames = Math.max(1, Math.ceil(chars / 10));
  const frameLength = 417; // 144 * 128000 / 44100, no padding
  const frame = Buffer.alloc(frameLength);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG-1, Layer III, no CRC
  frame[2] = 0x90; // 128 kbps, 44.1 kHz, no padding
  frame[3] = 0xc4; // mono
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...Buffer.alloc(10)]);
  return Buffer.concat([...(withId3 ? [id3] : []), ...Array.from({ length: frames }, () => frame)]);
}

export function mp3FrameSeconds(chars: number): number {
  return (Math.max(1, Math.ceil(chars / 10)) * 1152) / 44100;
}

export interface MockApi {
  baseURL: string;
  requests: RecordedRequest[];
  /** Synthesis requests only (HTTP and WebSocket). */
  synthesisRequests(): RecordedRequest[];
  intercept: Interceptor | undefined;
  /** Delay before answering each synthesis request, in milliseconds. */
  delayMs: number;
  /** Answer mp3 requests with WAV bytes labelled audio/mpeg, as the standard model does. */
  mp3AsWav: boolean;
  close(): Promise<void>;
}

function send(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
): void {
  send(res, status, JSON.stringify(json), { 'Content-Type': 'application/json', ...headers });
}

export async function startMockApi(): Promise<MockApi> {
  let seq = 0;
  const requests: RecordedRequest[] = [];
  const api: MockApi = {
    baseURL: '',
    requests,
    synthesisRequests: () => requests.filter((r) => r.path.startsWith('/v1/text-to-speech')),
    intercept: undefined,
    delayMs: 0,
    mp3AsWav: false,
    close: async () => {
      wss.clients.forEach((c) => {
        c.terminate();
      });
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | undefined;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        } catch {
          body = undefined;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          path,
          headers: req.headers,
          body,
          transport: 'http',
        };
        requests.push(recorded);
        if (req.headers['x-api-key'] !== TEST_KEY) {
          sendJson(res, 401, { message: 'Invalid authentication credentials', request_id: 'gw-1' });
          return;
        }
        const override = api.intercept?.(recorded);
        if (override) {
          sendJson(res, override.status, override.json, {
            'X-Request-Id': 'req_err',
            ...override.headers,
          });
          return;
        }
        if (req.method === 'GET' && path === '/v1/voices') {
          sendJson(
            res,
            200,
            { voices: VOICES, count: VOICES.length },
            { 'X-Request-Id': 'req_voices' },
          );
          return;
        }
        if (req.method === 'POST' && path === '/v1/text-to-speech' && body) {
          if (api.delayMs > 0) await new Promise((r) => setTimeout(r, api.delayMs));
          const n = ++seq;
          const text = str(body.text);
          const format = (body.output_format ?? {
            container: 'wav',
            encoding: 'pcm_s16le',
          }) as OutputFormat;
          const rate = format.sample_rate ?? 24000;
          const headers: Record<string, string> = { 'X-Request-Id': `req_${n}` };
          if (format.container === 'mp3' && api.mp3AsWav) {
            const pcm = pcmFor(codePoints(text), n);
            send(res, 200, Buffer.concat([wavHeader(pcm.byteLength, 24000), pcm]), {
              ...headers,
              'Content-Type': 'audio/mpeg',
              'X-Audio-Format': 'mp3',
            });
            return;
          }
          if (format.container === 'mp3') {
            send(res, 200, mp3For(codePoints(text)), {
              ...headers,
              'Content-Type': 'audio/mpeg',
              'X-Audio-Format': 'mp3',
            });
            return;
          }
          const encoding = format.encoding ?? 'pcm_s16le';
          const pcm = pcmFor(codePoints(text), n, encoding);
          const audioHeaders = {
            'X-Audio-Format': encoding,
            'X-Audio-Sample-Rate': String(rate),
            'X-Audio-Channels': '1',
          };
          if (format.container === 'raw') {
            send(res, 200, pcm, {
              ...headers,
              ...audioHeaders,
              'Content-Type': encoding === 'pcm_mulaw' ? 'audio/basic' : 'audio/pcm',
            });
            return;
          }
          send(res, 200, Buffer.concat([wavHeader(pcm.byteLength, rate, encoding), pcm]), {
            ...headers,
            ...audioHeaders,
            'Content-Type': 'audio/wav',
          });
          return;
        }
        sendJson(res, 404, { message: 'no Route matched with those values', request_id: 'gw-404' });
      })().catch(() => {
        res.destroy();
      });
    });
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/v1/text-to-speech/ws') {
      socket.destroy();
      return;
    }
    if (req.headers['x-api-key'] !== TEST_KEY) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"message":"Invalid authentication credentials"}',
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Requests of one context run in order: chain them.
      const queues = new Map<string, Promise<void>>();
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<
            string,
            unknown
          >;
        } catch {
          return;
        }
        const contextId = str(message.context_id);
        const recorded: RecordedRequest = {
          method: 'WS',
          path: '/v1/text-to-speech/ws',
          headers: req.headers,
          body: message,
          transport: 'ws',
        };
        requests.push(recorded);
        if (message.cancel === true) {
          ws.send(JSON.stringify({ type: 'cancelled', done: true, context_id: contextId }));
          return;
        }
        const n = ++seq;
        const requestId = `req_${n}`;
        const run = async (): Promise<void> => {
          if (api.delayMs > 0) await new Promise((r) => setTimeout(r, api.delayMs));
          const override = api.intercept?.(recorded);
          if (override) {
            ws.send(
              JSON.stringify({
                type: 'error',
                done: true,
                status_code: override.status,
                context_id: contextId,
                request_id: requestId,
                ...override.json,
              }),
            );
            return;
          }
          const format = (message.output_format ?? {}) as OutputFormat;
          const pcm = pcmFor(codePoints(str(message.text)), n, format.encoding ?? 'pcm_f32le');
          // Several chunks, split at odd offsets so samples straddle chunk boundaries.
          const step = Math.max(1, Math.floor(pcm.byteLength / 3) + 1);
          for (let i = 0; i < pcm.byteLength; i += step) {
            ws.send(
              JSON.stringify({
                type: 'chunk',
                done: false,
                context_id: contextId,
                request_id: requestId,
                data: pcm.subarray(i, i + step).toString('base64'),
              }),
            );
            await new Promise((r) => setImmediate(r));
          }
          ws.send(
            JSON.stringify({
              type: 'done',
              done: true,
              context_id: contextId,
              request_id: requestId,
            }),
          );
        };
        const previous = queues.get(contextId) ?? Promise.resolve();
        queues.set(contextId, previous.then(run));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}
