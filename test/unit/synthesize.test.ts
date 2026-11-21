import { toWav } from 'bakbak';
import { describe, expect, it } from 'vitest';

import { parseWav, patchWavHeader } from '../../src/audio/format.js';
import type { AudioSink } from '../../src/audio/sink.js';
import { Mp3UnavailableError, synthesize } from '../../src/audio/synthesize.js';
import type { Backend, SynthesisParams, TtsClient } from '../../src/backend/types.js';
import { codePointLength } from '../../src/util.js';
import { mp3For, pcmFor, wavHeader } from '../helpers/mockApi.js';

/** Records writes; reproduces the file in memory for checking. */
class RecordingSink implements AudioSink {
  writes: number[] = [];
  data = Buffer.alloc(0);
  maxWrite = 0;
  async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk.byteLength);
    this.maxWrite = Math.max(this.maxWrite, chunk.byteLength);
    this.data = Buffer.concat([this.data, chunk]);
    return Promise.resolve();
  }
  async writeAt(chunk: Uint8Array, position: number): Promise<void> {
    Buffer.from(chunk).copy(this.data, position);
    return Promise.resolve();
  }
  get bytesWritten(): number {
    return this.data.byteLength;
  }
}

const backend = {
  splitSentences: (text: string) => text.split(/(?<=\.)\s+/),
  toWav: (audio: Uint8Array, encoding: string, sampleRate: number) =>
    toWav(audio, { encoding, sampleRate }),
} as unknown as Backend;

const LONG = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} is right here.`).join(' ');

function params(output_format: SynthesisParams['output_format']): SynthesisParams {
  return { text: LONG, voice_id: 'v', language: 'en', output_format };
}

/** A client whose WebSocket path delivers each piece as several small chunks. */
function streamingClient(encoding = 'pcm_s16le'): TtsClient {
  return {
    listVoices: () => Promise.resolve([]),
    generate: () => Promise.reject(new Error('unused')),
    async streamPieces(pieces, _params, onAudio) {
      let bytes = 0;
      for (const [i, piece] of pieces.entries()) {
        const pcm = pcmFor(codePointLength(piece), i + 1, encoding);
        for (let at = 0; at < pcm.byteLength; at += 4096) {
          const chunk = pcm.subarray(at, at + 4096);
          bytes += chunk.byteLength;
          await onAudio(chunk);
        }
      }
      return { requestIds: pieces.map((_, i) => `req_${i}`), bytes };
    },
  };
}

describe('synthesize: long text', () => {
  it('streams chunks to the sink (never the whole audio at once) and fixes the WAV header', async () => {
    const sink = new RecordingSink();
    const result = await synthesize(
      backend,
      streamingClient(),
      params({ container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 }),
      sink,
    );
    expect(result.pieces).toBeGreaterThan(1);
    expect(sink.writes.length).toBeGreaterThan(result.pieces * 2);
    expect(sink.maxWrite).toBeLessThanOrEqual(4096);
    const info = parseWav(sink.data)!;
    expect(info.dataBytes).toBe(sink.data.byteLength - 44);
    expect(sink.data.readUInt32LE(4)).toBe(sink.data.byteLength - 8);
    expect(result.durationSeconds).toBeCloseTo(info.dataBytes / 2 / 24000, 9);
  });

  it('writes a correct 58-byte header (with fact chunk) for f32', async () => {
    const sink = new RecordingSink();
    await synthesize(
      backend,
      streamingClient('pcm_f32le'),
      params({ container: 'wav', encoding: 'pcm_f32le', sample_rate: 16000 }),
      sink,
    );
    const pcm = sink.data.subarray(58);
    expect(
      sink.data
        .subarray(0, 58)
        .equals(
          Buffer.from(toWav(pcm, { encoding: 'pcm_f32le', sampleRate: 16000 }).subarray(0, 58)),
        ),
    ).toBe(true);
  });

  it('refuses to glue WAV pieces under an mp3 label', async () => {
    const wavClient: TtsClient = {
      listVoices: () => Promise.resolve([]),
      generate: (p) => {
        const pcm = pcmFor(codePointLength(p.text), 1);
        return Promise.resolve({
          data: Buffer.concat([wavHeader(pcm.byteLength, 24000), pcm]),
          requestId: 'r',
          contentType: 'audio/mpeg',
        });
      },
      streamPieces: () => Promise.reject(new Error('unused')),
    };
    const sink = new RecordingSink();
    await expect(
      synthesize(backend, wavClient, params({ container: 'mp3' }), sink),
    ).rejects.toThrow(Mp3UnavailableError);
    expect(sink.bytesWritten).toBe(0);
  });

  it('joins real MP3 pieces', async () => {
    const mp3Client: TtsClient = {
      listVoices: () => Promise.resolve([]),
      generate: (p) =>
        Promise.resolve({
          data: mp3For(codePointLength(p.text)),
          requestId: 'r',
          contentType: 'audio/mpeg',
        }),
      streamPieces: () => Promise.reject(new Error('unused')),
    };
    const sink = new RecordingSink();
    const result = await synthesize(backend, mp3Client, params({ container: 'mp3' }), sink);
    expect(sink.writes).toHaveLength(result.pieces);
  });
});

describe('patchWavHeader', () => {
  it.each(['pcm_s16le', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw'])(
    'matches toWav for %s',
    (encoding) => {
      const pcm = pcmFor(37, 3, encoding);
      const expected = toWav(pcm, { encoding, sampleRate: 8000 });
      const empty = toWav(new Uint8Array(0), { encoding, sampleRate: 8000 });
      const patched = patchWavHeader(empty, pcm.byteLength);
      expect(Buffer.from(patched).equals(Buffer.from(expected.subarray(0, empty.byteLength)))).toBe(
        true,
      );
    },
  );
});
