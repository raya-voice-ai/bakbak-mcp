import { describe, expect, it } from 'vitest';

import {
  acceptedExtensions,
  audioDuration,
  extensionFor,
  id3v2Length,
  mimeTypeFor,
  mp3Duration,
  parseWav,
} from '../../src/audio/format.js';
import { mp3For, mp3FrameSeconds, pcmFor, wavHeader } from '../helpers/mockApi.js';

describe('extensions and MIME types', () => {
  it.each([
    [{ container: 'wav', encoding: 'pcm_s16le' }, 'wav', 'audio/wav'],
    [{ container: 'mp3' }, 'mp3', 'audio/mpeg'],
    [{ container: 'raw', encoding: 'pcm_s16le' }, 'pcm', 'audio/pcm'],
    [{ container: 'raw', encoding: 'pcm_f32le' }, 'f32', 'audio/pcm'],
    [{ container: 'raw', encoding: 'pcm_mulaw' }, 'ulaw', 'audio/basic'],
    [{ container: 'raw', encoding: 'pcm_alaw' }, 'alaw', 'application/octet-stream'],
    [{ container: 'raw', encoding: 'pcm_future' }, 'raw', 'application/octet-stream'],
    [{ container: 'opus' }, 'opus', 'application/octet-stream'],
    [{ container: '../x' }, 'bin', 'application/octet-stream'],
  ])('%j → .%s %s', (format, ext, mime) => {
    expect(extensionFor(format)).toBe(ext);
    expect(mimeTypeFor(format)).toBe(mime);
  });

  it('accepts .raw as well as the specific extension for raw audio', () => {
    expect(acceptedExtensions({ container: 'raw', encoding: 'pcm_s16le' })).toEqual(['pcm', 'raw']);
    expect(acceptedExtensions({ container: 'wav', encoding: 'pcm_s16le' })).toEqual(['wav']);
  });
});

describe('durations', () => {
  it('reads a WAV header', () => {
    const pcm = pcmFor(100, 1); // 2400 samples
    const wav = Buffer.concat([wavHeader(pcm.byteLength, 24000), pcm]);
    expect(parseWav(wav)).toEqual({ sampleRate: 24000, blockAlign: 2, dataBytes: pcm.byteLength });
    expect(audioDuration(wav, { container: 'wav' })).toBeCloseTo(0.1, 6);
  });

  it('counts the bytes present when the data size is 0xFFFFFFFF (progressive WAV)', () => {
    const pcm = pcmFor(50, 1);
    const header = wavHeader(pcm.byteLength, 24000);
    header.writeUInt32LE(0xffffffff, 40);
    header.writeUInt32LE(0xffffffff, 4);
    expect(audioDuration(Buffer.concat([header, pcm]), { container: 'wav' })).toBeCloseTo(0.05, 6);
  });

  it('computes raw durations from the encoding and sample rate', () => {
    expect(
      audioDuration(pcmFor(100, 1, 'pcm_f32le'), { container: 'raw', encoding: 'pcm_f32le' }),
    ).toBeCloseTo(0.1, 6);
    expect(
      audioDuration(Buffer.alloc(8000), {
        container: 'raw',
        encoding: 'pcm_mulaw',
        sample_rate: 8000,
      }),
    ).toBe(1);
  });

  it('walks MP3 frames and skips an ID3v2 tag', () => {
    const mp3 = mp3For(95);
    expect(id3v2Length(mp3)).toBe(20);
    expect(mp3Duration(mp3)).toBeCloseTo(mp3FrameSeconds(95), 6);
    expect(audioDuration(mp3, { container: 'mp3' })).toBeCloseTo(mp3FrameSeconds(95), 6);
  });

  it('measures WAV bytes even when they were labelled mp3', () => {
    const pcm = pcmFor(10, 1);
    expect(
      audioDuration(Buffer.concat([wavHeader(pcm.byteLength, 24000), pcm]), { container: 'mp3' }),
    ).toBeCloseTo(0.01, 6);
  });

  it('resynchronises over garbage between frames', () => {
    const frames = mp3For(20, false);
    const noisy = Buffer.concat([Buffer.from([1, 2, 3]), frames]);
    expect(mp3Duration(noisy)).toBeCloseTo(mp3FrameSeconds(20), 6);
  });
});
