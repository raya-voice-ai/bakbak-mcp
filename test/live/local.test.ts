import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type LocalHarness, connectLocal, textOf } from '../helpers/localServer.js';
import { LIVE, LIVE_BASE_URL, LIVE_KEY, decodeWav, median } from './env.js';

describe.skipIf(!LIVE)('live: local mode', () => {
  let h: LocalHarness;
  beforeAll(async () => {
    h = await connectLocal(LIVE_BASE_URL, { apiKey: LIVE_KEY });
  });
  afterAll(async () => {
    await h.close();
  });

  it('voices: lists the catalogue and filters it', async () => {
    const all = await h.client.callTool({ name: 'list_voices', arguments: { limit: 500 } });
    const out = all.structuredContent as {
      total: number;
      voices: { id: string; language: string; model: string }[];
    };
    expect(out.total).toBeGreaterThan(0);
    const hindi = await h.client.callTool({ name: 'list_voices', arguments: { language: 'hi' } });
    const hi = hindi.structuredContent as { voices: { language: string }[] };
    expect(hi.voices.length).toBeGreaterThan(0);
    expect(hi.voices.every((v) => v.language === 'hi')).toBe(true);
  });

  it('whole file: speaks Hindi into a WAV that decodes, with the reported duration', async () => {
    const timings: number[] = [];
    for (const text of ['नमस्ते, आप कैसे हैं?', 'आज मौसम बहुत अच्छा है।', 'धन्यवाद।']) {
      const started = performance.now();
      const result = await h.client.callTool({
        name: 'text_to_speech',
        arguments: { text, language: 'hi' },
      });
      timings.push(performance.now() - started);
      expect(result.isError, textOf(result)).toBeFalsy();
      const out = result.structuredContent as {
        file_path: string;
        duration_seconds: number;
        request_ids: string[];
      };
      const wav = decodeWav(await readFile(out.file_path));
      expect(wav.seconds).toBeCloseTo(out.duration_seconds, 2);
      expect(wav.seconds).toBeGreaterThan(0.3);
      expect(wav.seconds).toBeLessThan(15);
      expect(wav.rms).toBeGreaterThan(50); // not silence
      expect(out.request_ids).toHaveLength(1);
    }
    console.info(
      `live local text_to_speech (whole file): p50 ${Math.round(median(timings))} ms, n=${timings.length}`,
    );
  });

  it('whole file: reports API errors as tool errors', async () => {
    const result = await h.client.callTool({
      name: 'text_to_speech',
      arguments: { text: 'नमस्ते', language: 'hi', voice_id: 'no-such-voice', model: 'standard' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Next step/);
  });

  it('websocket: streams pieces on one context and joins them under one WAV header', async () => {
    const voices = (
      await h.client.callTool({ name: 'list_voices', arguments: { language: 'hi', limit: 1 } })
    ).structuredContent as { voices: { id: string; model: string }[] };
    const voice = voices.voices[0]!;
    const client = h.backend.client(LIVE_KEY);
    const started = performance.now();
    const chunks: Uint8Array[] = [];
    const streamed = await client.streamPieces(
      ['पहला वाक्य यह है।', 'और यह दूसरा वाक्य है।'],
      {
        voice_id: voice.id,
        language: 'hi',
        model: voice.model,
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      },
      (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    );
    const ms = performance.now() - started;
    expect(streamed.requestIds).toHaveLength(2);
    const pcm = Buffer.concat(chunks);
    expect(pcm.byteLength).toBe(streamed.bytes);
    const wav = decodeWav(h.backend.toWav(pcm, 'pcm_s16le', 24000));
    expect(wav.seconds).toBeCloseTo(pcm.byteLength / 2 / 24000, 6);
    expect(wav.seconds).toBeGreaterThan(1);
    expect(wav.rms).toBeGreaterThan(50);
    console.info(
      `live websocket two pieces: ${Math.round(ms)} ms total for ${wav.seconds.toFixed(2)} s of audio`,
    );
  });
});
