import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseWav } from '../../src/audio/format.js';
import { codePointLength } from '../../src/util.js';
import { type LocalHarness, connectLocal, textOf } from '../helpers/localServer.js';
import {
  type MockApi,
  SAMPLES_PER_CHAR,
  VOICES,
  mp3FrameSeconds,
  startMockApi,
} from '../helpers/mockApi.js';

let api: MockApi;
let h: LocalHarness;

beforeAll(async () => {
  api = await startMockApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  api.requests.length = 0;
  api.intercept = undefined;
  api.delayMs = 0;
  h = await connectLocal(api.baseURL);
});
afterEach(async () => {
  await h.close();
});

type ToolResult = Awaited<ReturnType<LocalHarness['client']['callTool']>>;

function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return h.client.callTool({ name, arguments: args });
}

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** A Hindi sentence of exactly 50 code points. */
const SENTENCE = 'यह एक लंबा वाक्य है जो परीक्षण के लिए लिखा गया है।';

describe('discovery', () => {
  it('lists exactly the two tools, with annotations and server instructions', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_voices', 'text_to_speech']);
    const tts = tools.find((t) => t.name === 'text_to_speech')!;
    expect(tts.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tts.description).toMatch(/credits/);
    const voices = tools.find((t) => t.name === 'list_voices')!;
    expect(voices.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    const instructions = h.client.getInstructions() ?? '';
    expect(instructions).toMatch(/list_voices/);
    expect(instructions).toMatch(/Devanagari/);
    expect(instructions).toMatch(/credits/);
    expect(instructions).toMatch(/model/);
  });
});

describe('list_voices', () => {
  it('returns every voice by default', async () => {
    const out = structured(await call('list_voices', {}));
    expect(out).toEqual({ voices: VOICES, count: VOICES.length, total: VOICES.length });
  });

  it('filters by language, model and name, and limits', async () => {
    expect(structured(await call('list_voices', { language: 'hi' })).total).toBe(3);
    expect(structured(await call('list_voices', { language: 'hi', model: 'm1' })).voices).toEqual([
      VOICES[3],
    ]);
    expect(structured(await call('list_voices', { query: 'm1' })).count).toBe(2);
    const limited = structured(await call('list_voices', { limit: 2 }));
    expect(limited).toMatchObject({ count: 2, total: VOICES.length });
    expect(textOf(await call('list_voices', { limit: 2 }))).toMatch(/showing the first 2/);
  });

  it('fetches the catalogue once and caches it', async () => {
    await call('list_voices', {});
    await call('list_voices', { language: 'ta' });
    expect(api.requests.filter((r) => r.path === '/v1/voices')).toHaveLength(1);
  });
});

describe('text_to_speech: short text', () => {
  it('picks the first voice for the language and saves a WAV in the output directory', async () => {
    const text = 'नमस्ते दुनिया';
    const out = structured(await call('text_to_speech', { text, language: 'hi' }));
    const filePath = out.file_path as string;
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(path.dirname(filePath)).toBe(h.outputDir);
    expect(path.basename(filePath)).toMatch(/^hi_Kavya_\d{8}T\d{6}Z_[a-z0-9]{6}\.wav$/);
    expect(out).toMatchObject({
      format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 24000,
        mime_type: 'audio/wav',
      },
      characters: 13,
      voice_id: 'v-hi-std-1',
      model: 'standard',
      language: 'hi',
    });
    expect(out.request_ids).toEqual([expect.stringMatching(/^req_\d+$/)]);
    expect(out.duration_seconds).toBeCloseTo((13 * SAMPLES_PER_CHAR) / 24000, 3);
    const wav = await readFile(filePath);
    expect(parseWav(wav)?.dataBytes).toBe(13 * SAMPLES_PER_CHAR * 2);
    const [request] = api.synthesisRequests();
    expect(request?.headers['x-bakbak-client']).toMatch(/^bakbak-mcp\/\S+ bakbak-js\/\S+$/);
    expect(request?.body).toEqual({
      text,
      voice_id: 'v-hi-std-1',
      language: 'hi',
      model: 'standard',
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
    });
  });

  it('honours the model when picking a voice', async () => {
    const out = structured(
      await call('text_to_speech', { text: 'नमस्ते', language: 'hi', model: 'm1' }),
    );
    expect(out).toMatchObject({ voice_id: 'v-hi-m1', model: 'm1' });
  });

  it("fills in the voice's own model when only voice_id is given", async () => {
    const out = structured(
      await call('text_to_speech', { text: 'Hello', language: 'en', voice_id: VOICES[2]!.id }),
    );
    expect(out.model).toBe('m1');
    expect(api.synthesisRequests()[0]?.body?.model).toBe('m1');
  });

  it('sends voice_id and model as given without listing voices', async () => {
    await call('text_to_speech', {
      text: 'Hello',
      language: 'en',
      voice_id: VOICES[2]!.id,
      model: 'm1',
      speed: 1.2,
    });
    expect(api.requests.some((r) => r.path === '/v1/voices')).toBe(false);
    expect(api.synthesisRequests()[0]?.body).toMatchObject({ speed: 1.2, model: 'm1' });
  });

  it('writes mp3 and raw with their true extensions', async () => {
    const mp3 = structured(
      await call('text_to_speech', {
        text: 'Hello there',
        language: 'hi',
        output_format: { container: 'mp3' },
      }),
    );
    expect(mp3.file_path).toMatch(/\.mp3$/);
    expect(mp3.format).toEqual({ container: 'mp3', mime_type: 'audio/mpeg' });
    expect(mp3.duration_seconds).toBeCloseTo(mp3FrameSeconds(11), 3);
    const raw = structured(
      await call('text_to_speech', {
        text: 'Hello',
        language: 'hi',
        output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      }),
    );
    expect(raw.file_path).toMatch(/\.ulaw$/);
    expect(raw.format).toEqual({
      container: 'raw',
      encoding: 'pcm_mulaw',
      sample_rate: 8000,
      mime_type: 'audio/basic',
    });
  });

  it('says when no voice exists for the language', async () => {
    const result = await call('text_to_speech', { text: 'hello', language: 'xx' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No voice is available for language "xx".*list_voices/s);
    expect(api.synthesisRequests()).toHaveLength(0);
  });
});

describe('text_to_speech: long text', () => {
  const long = Array.from({ length: 240 }, () => SENTENCE).join(' '); // 12,239 code points

  it('streams raw PCM over one WebSocket context and writes one WAV header', async () => {
    const out = structured(await call('text_to_speech', { text: long, language: 'hi' }));
    const pieces = api.synthesisRequests();
    expect(pieces.length).toBe(3);
    const contextIds = new Set(pieces.map((p) => p.body?.context_id));
    expect(contextIds.size).toBe(1);
    for (const piece of pieces) {
      expect(piece.transport).toBe('ws');
      expect(codePointLength(String(piece.body?.text))).toBeLessThanOrEqual(5000);
      expect(piece.body?.output_format).toEqual({
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 24000,
      });
    }
    expect(pieces.map((p) => p.body?.text).join(' ')).toBe(long);

    const wav = await readFile(out.file_path as string);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    const info = parseWav(wav)!;
    expect(info.dataBytes).toBe(wav.byteLength - 44);
    // Every sample carries its request's sequence number: they must be in send order.
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, info.dataBytes / 2);
    const runs: number[] = [];
    for (const s of samples) if (runs.at(-1) !== s) runs.push(s);
    expect(runs).toHaveLength(pieces.length);
    expect(runs.every((v, i) => i === 0 || v === runs[i - 1]! + 1)).toBe(true);
    expect(out.request_ids).toEqual(runs.map((n) => `req_${n}`));
    const spokenChars = pieces.reduce((n, p) => n + codePointLength(String(p.body?.text)), 0);
    expect(samples.length).toBe(spokenChars * SAMPLES_PER_CHAR);
    expect(out.duration_seconds).toBeCloseTo((spokenChars * SAMPLES_PER_CHAR) / 24000, 3);
    expect(out.characters).toBe(codePointLength(long));
  });

  it('makes one generate call per piece for mp3 and keeps one ID3 tag', async () => {
    const out = structured(
      await call('text_to_speech', {
        text: long,
        language: 'hi',
        output_format: { container: 'mp3' },
      }),
    );
    const pieces = api.synthesisRequests();
    expect(pieces.length).toBe(3);
    expect(pieces.every((p) => p.transport === 'http' && p.path === '/v1/text-to-speech')).toBe(
      true,
    );
    const mp3 = await readFile(out.file_path as string);
    expect(mp3.subarray(0, 3).toString()).toBe('ID3');
    expect(mp3.indexOf('ID3', 3)).toBe(-1);
    const expected = pieces.reduce(
      (s, p) => s + mp3FrameSeconds(codePointLength(String(p.body?.text))),
      0,
    );
    expect(out.duration_seconds).toBeCloseTo(expected, 3);
  });

  it('assembles raw f32 without a header', async () => {
    const out = structured(
      await call('text_to_speech', {
        text: long,
        language: 'hi',
        output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: 16000 },
      }),
    );
    expect(out.file_path).toMatch(/\.f32$/);
    const raw = await readFile(out.file_path as string);
    const spokenChars = api
      .synthesisRequests()
      .reduce((n, p) => n + codePointLength(String(p.body?.text)), 0);
    expect(raw.byteLength).toBe(spokenChars * SAMPLES_PER_CHAR * 4);
  });

  it('stops after the first failed piece and reports it', async () => {
    let n = 0;
    api.intercept = (r) =>
      r.transport === 'ws' && ++n === 2
        ? {
            status: 402,
            json: {
              error_code: 'insufficient_credits',
              message: 'Insufficient balance.',
              retryable: false,
            },
          }
        : undefined;
    const result = await call('text_to_speech', { text: long, language: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Insufficient balance/);
    expect(textOf(result)).toMatch(/insufficient_credits/);
    expect(await readdir(h.outputDir)).toEqual([]);
  });

  it('refuses more than 50,000 characters', async () => {
    const result = await call('text_to_speech', { text: 'क'.repeat(50_001), language: 'hi' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/50000/);
    expect(api.synthesisRequests()).toHaveLength(0);
  });
});

describe('errors', () => {
  it('names BAKBAK_API_KEY and the dashboard when no key is set, yet lists tools', async () => {
    const noKey = await connectLocal(api.baseURL, { apiKey: undefined });
    try {
      expect((await noKey.client.listTools()).tools).toHaveLength(2);
      for (const [name, args] of [
        ['text_to_speech', { text: 'hi', language: 'hi' }],
        ['list_voices', {}],
      ] as const) {
        const result = await noKey.client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/BAKBAK_API_KEY/);
        expect(textOf(result)).toMatch(/https:\/\/bakbak\.getraya\.app/);
      }
      expect(api.requests).toHaveLength(0);
    } finally {
      await noKey.close();
    }
  });

  it('maps the current error shape: message, error_code, request_id and a next step', async () => {
    api.intercept = (r) =>
      r.path === '/v1/text-to-speech'
        ? {
            status: 402,
            json: {
              detail: 'Insufficient balance',
              error_code: 'insufficient_credits',
              message: 'Your balance is too low for this request.',
              retryable: false,
              request_id: 'req_body',
              required_inr: 2,
            },
            headers: { 'X-Request-Id': 'req_402' },
          }
        : undefined;
    const result = await call('text_to_speech', { text: 'नमस्ते', language: 'hi' });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/Your balance is too low/);
    expect(text).toMatch(/Add credits at https:\/\/bakbak\.getraya\.app/);
    const details = JSON.parse(text.slice(text.indexOf('{'))) as { error: Record<string, unknown> };
    expect(details.error).toMatchObject({
      status: 402,
      error_code: 'insufficient_credits',
      request_id: 'req_402',
      retryable: false,
    });
  });

  it('maps legacy and gateway shapes', async () => {
    api.intercept = (r) =>
      r.path === '/v1/text-to-speech'
        ? { status: 404, json: { detail: 'Voice not found' } }
        : undefined;
    const notFound = await call('text_to_speech', {
      text: 'x',
      language: 'hi',
      voice_id: 'nope',
      model: 'standard',
    });
    expect(textOf(notFound)).toMatch(/Voice not found.*list_voices/s);

    api.intercept = (r) =>
      r.path === '/v1/text-to-speech'
        ? {
            status: 422,
            json: {
              detail: [{ loc: ['body', 'voice_id'], msg: 'Field required', type: 'missing' }],
            },
          }
        : undefined;
    expect(
      textOf(
        await call('text_to_speech', {
          text: 'x',
          language: 'hi',
          voice_id: 'v',
          model: 'standard',
        }),
      ),
    ).toMatch(/voice_id: Field required/);

    const badKey = await connectLocal(api.baseURL, { apiKey: 'wrong' });
    try {
      const result = await badKey.client.callTool({ name: 'list_voices', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(
        /Invalid authentication credentials.*BAKBAK_API_KEY was rejected/s,
      );
    } finally {
      await badKey.close();
    }
  });

  it('turns argument validation failures into tool errors, and never accepts a key argument', async () => {
    const withKey = await call('text_to_speech', { text: 'x', language: 'hi', api_key: 'sneaky' });
    expect(withKey.isError).toBe(true);
    expect(textOf(withKey)).toMatch(/api_key/);
    expect((await call('text_to_speech', { text: '', language: 'hi' })).isError).toBe(true);
    expect((await call('text_to_speech', { text: 'x' })).isError).toBe(true);
    expect((await call('list_voices', { limit: 0 })).isError).toBe(true);
    expect(api.synthesisRequests()).toHaveLength(0);
  });

  it('asks for an encoding before splitting long wav text', async () => {
    const result = await call('text_to_speech', {
      text: SENTENCE.repeat(120),
      language: 'hi',
      output_format: { container: 'wav' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/output_format\.encoding is required/);
  });
});

describe('output_path', () => {
  it('writes to an absolute path and returns it', async () => {
    const target = path.join(h.outputDir, 'custom.wav');
    const out = structured(
      await call('text_to_speech', { text: 'hello', language: 'hi', output_path: target }),
    );
    expect(out.file_path).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('resolves a relative path inside the output directory', async () => {
    await mkdir(path.join(h.outputDir, 'clips'));
    const out = structured(
      await call('text_to_speech', { text: 'hello', language: 'hi', output_path: 'clips/a.wav' }),
    );
    expect(out.file_path).toBe(path.join(h.outputDir, 'clips', 'a.wav'));
  });

  it('never overwrites without overwrite, and checks before spending credits', async () => {
    const target = path.join(h.outputDir, 'keep.wav');
    await writeFile(target, 'original');
    const refused = await call('text_to_speech', {
      text: 'hello',
      language: 'hi',
      output_path: target,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/already exists.*overwrite/s);
    expect(api.synthesisRequests()).toHaveLength(0);
    expect(await readFile(target, 'utf8')).toBe('original');

    structured(
      await call('text_to_speech', {
        text: 'hello',
        language: 'hi',
        output_path: target,
        overwrite: true,
      }),
    );
    expect((await readFile(target)).subarray(0, 4).toString()).toBe('RIFF');
  });

  it.each([
    ['../escape.wav', /stay inside the output directory/],
    ['clips/../../escape.wav', /stay inside the output directory/],
    ['wrong.mp3', /must end in \.wav/],
    ['/definitely/not/a/dir/x.wav', /does not exist/],
  ])('refuses %s', async (outputPath, message) => {
    const result = await call('text_to_speech', {
      text: 'hello',
      language: 'hi',
      output_path: outputPath,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(message);
    expect(api.synthesisRequests()).toHaveLength(0);
  });
});

describe('include_audio', () => {
  it('adds an audio block for small audio', async () => {
    const result = await call('text_to_speech', {
      text: 'hello',
      language: 'hi',
      include_audio: true,
    });
    const audio = (result.content as { type: string; data?: string; mimeType?: string }[]).find(
      (b) => b.type === 'audio',
    );
    expect(audio?.mimeType).toBe('audio/wav');
    const bytes = Buffer.from(audio?.data ?? '', 'base64');
    expect(bytes.equals(await readFile(structured(result).file_path as string))).toBe(true);
  });

  it('explains the 1 MB limit for larger audio, and keeps the file', async () => {
    // 24 samples × 2 bytes per character: about 22,000 characters exceed 1 MB.
    const text = Array.from({ length: 460 }, () => SENTENCE).join(' ');
    const result = await call('text_to_speech', { text, language: 'hi', include_audio: true });
    expect(result.isError).toBe(true);
    const message = textOf(result);
    expect(message).toMatch(/over the 1 MB limit/);
    expect(message).toMatch(/Do not synthesize this text again/);
    const files = await readdir(h.outputDir);
    expect(files).toHaveLength(1);
    expect(message).toContain(path.join(h.outputDir, files[0]!));
  });
});

describe('cancellation', () => {
  it('stops a long synthesis when the client cancels the call', async () => {
    api.delayMs = 300; // per piece
    const controller = new AbortController();
    const text = Array.from({ length: 240 }, () => SENTENCE).join(' ');
    const pending = h.client.callTool(
      { name: 'text_to_speech', arguments: { text, language: 'hi' } },
      {
        signal: controller.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await expect(pending).rejects.toThrow();
    // Give the server a moment to see the cancellation, then nothing more is sent.
    await new Promise((r) => setTimeout(r, 1200));
    // The context was cancelled on the WebSocket, and no file was written.
    expect(api.synthesisRequests().some((r) => r.body?.cancel === true)).toBe(true);
    expect(await readdir(h.outputDir)).toEqual([]);
  });
});
