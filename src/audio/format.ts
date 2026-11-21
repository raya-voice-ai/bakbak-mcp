/**
 * Facts about audio formats: defaults, file extensions, MIME types and
 * durations. Durations are measured from the bytes, so a file reports what it
 * really holds.
 */

import type { Encoding, OutputFormat } from '../backend/types.js';

/** What `text_to_speech` produces when no `output_format` is given. */
export const DEFAULT_OUTPUT_FORMAT: Readonly<Required<OutputFormat>> = Object.freeze({
  container: 'wav',
  encoding: 'pcm_s16le',
  sample_rate: 24000,
});

/** The API's default sample rate when `sample_rate` is omitted. */
export const DEFAULT_SAMPLE_RATE = 24000;

/** Bytes per (mono) sample, or undefined for an encoding this server does not know. */
export function bytesPerSample(encoding: Encoding | undefined): number | undefined {
  switch (encoding) {
    case 'pcm_s16le':
      return 2;
    case 'pcm_f32le':
      return 4;
    case 'pcm_mulaw':
    case 'pcm_alaw':
      return 1;
    default:
      return undefined;
  }
}

const RAW_EXTENSIONS: Record<string, string> = {
  pcm_s16le: 'pcm',
  pcm_f32le: 'f32',
  pcm_mulaw: 'ulaw',
  pcm_alaw: 'alaw',
};

/** The file extension (without the dot) for audio in this format. */
export function extensionFor(format: OutputFormat): string {
  if (format.container === 'wav') return 'wav';
  if (format.container === 'mp3') return 'mp3';
  if (format.container === 'raw') return RAW_EXTENSIONS[format.encoding ?? ''] ?? 'raw';
  // An unknown future container: keep its name if it is a safe extension.
  return /^[a-z0-9]{1,8}$/.test(format.container) ? format.container : 'bin';
}

/** Extensions accepted for a caller-chosen `output_path`. */
export function acceptedExtensions(format: OutputFormat): string[] {
  const ext = extensionFor(format);
  return format.container === 'raw' && ext !== 'raw' ? [ext, 'raw'] : [ext];
}

/** The MIME type for audio in this format, matching what the API sends for the same format. */
export function mimeTypeFor(format: OutputFormat): string {
  switch (format.container) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'raw':
      if (format.encoding === 'pcm_mulaw') return 'audio/basic';
      if (format.encoding === 'pcm_s16le' || format.encoding === 'pcm_f32le') return 'audio/pcm';
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

interface WavInfo {
  sampleRate: number;
  blockAlign: number;
  dataBytes: number;
}

/**
 * Reads a RIFF/WAVE header. A `data` size of 0xFFFFFFFF (progressive WAV) or
 * one past the end of the buffer counts the bytes actually present.
 */
export function parseWav(bytes: Uint8Array): WavInfo | undefined {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === 'data') {
      if (sampleRate === 0 || blockAlign === 0) return undefined;
      const available = bytes.byteLength - body;
      const dataBytes = size === 0xffffffff || size > available ? available : size;
      return { sampleRate, blockAlign, dataBytes };
    }
    // Chunks are word-aligned. A bogus size simply ends the walk.
    offset = body + size + (size % 2);
  }
  return undefined;
}

/**
 * A copy of a WAV header (as `toWav` writes for empty audio) with its sizes
 * set for `dataBytes` of audio: the RIFF size, the `fact` sample count when
 * present, and the `data` size. The header must end with the `data` chunk's
 * header, so the audio follows it directly.
 */
export function patchWavHeader(header: Uint8Array, dataBytes: number): Uint8Array {
  const out = new Uint8Array(header);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (out.byteLength < 12 || ascii(out, 0, 4) !== 'RIFF') throw new Error('not a WAV header');
  view.setUint32(4, out.byteLength - 8 + dataBytes, true);
  let blockAlign = 1;
  let offset = 12;
  while (offset + 8 <= out.byteLength) {
    const id = ascii(out, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') blockAlign = view.getUint16(offset + 8 + 12, true) || 1;
    else if (id === 'fact') view.setUint32(offset + 8, Math.floor(dataBytes / blockAlign), true);
    else if (id === 'data') {
      view.setUint32(offset + 4, dataBytes, true);
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV header without a data chunk');
}

/** Generous seconds of speech per character, for estimating output size before synthesis. */
export const ESTIMATED_SECONDS_PER_CHAR = 0.15;
/** Assumed MP3 rate for estimates: 320 kbit/s, the most an MP3 uses. */
const MP3_BYTES_PER_SECOND = 40_000;

/** An upper estimate of the bytes `characters` of text become in this format. */
export function estimateOutputBytes(characters: number, format: OutputFormat): number {
  const seconds = characters * ESTIMATED_SECONDS_PER_CHAR;
  const perSecond =
    format.container === 'mp3'
      ? MP3_BYTES_PER_SECOND
      : (bytesPerSample(format.encoding) ?? 4) * (format.sample_rate ?? DEFAULT_SAMPLE_RATE);
  return Math.ceil(seconds * perSecond) + 1024;
}

/** Length of an ID3v2 tag at the start of `bytes`, or 0. */
export function id3v2Length(bytes: Uint8Array): number {
  if (bytes.byteLength < 10 || ascii(bytes, 0, 3) !== 'ID3') return 0;
  const [, , , , , flags = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0] = bytes;
  const size = ((s0 & 0x7f) << 21) | ((s1 & 0x7f) << 14) | ((s2 & 0x7f) << 7) | (s3 & 0x7f);
  const footer = flags & 0x10 ? 10 : 0;
  return Math.min(bytes.byteLength, 10 + size + footer);
}

const MP3_BITRATES_KBPS = {
  // [version 1, version 2/2.5] x layer (1..3) x index
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
} as const;

const MP3_SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

interface Mp3Frame {
  length: number;
  samples: number;
  sampleRate: number;
}

function readMp3Frame(bytes: Uint8Array, i: number): Mp3Frame | undefined {
  const b1 = bytes[i + 1] ?? 0;
  const b2 = bytes[i + 2] ?? 0;
  if (bytes[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = (b1 >> 3) & 0x03; // 0: 2.5, 2: 2, 3: 1
  const layerBits = (b1 >> 1) & 0x03; // 1: III, 2: II, 3: I
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15) {
    return undefined;
  }
  const sampleRate = MP3_SAMPLE_RATES[version]?.[rateIndex];
  if (sampleRate === undefined) return undefined;
  const layer = 4 - layerBits; // 1, 2 or 3
  const table = version === 3 ? MP3_BITRATES_KBPS.v1 : MP3_BITRATES_KBPS.v2;
  const bitrate = (table[layer - 1]?.[bitrateIndex] ?? 0) * 1000;
  if (layer === 1) {
    return {
      length: (Math.floor((12 * bitrate) / sampleRate) + padding) * 4,
      samples: 384,
      sampleRate,
    };
  }
  const samples = layer === 3 && version !== 3 ? 576 : 1152;
  return {
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding,
    samples,
    sampleRate,
  };
}

/** Seconds of audio in an MP3 stream, by walking its frames. */
export function mp3Duration(bytes: Uint8Array): number {
  let i = id3v2Length(bytes);
  let seconds = 0;
  let first = true;
  while (i + 4 <= bytes.byteLength) {
    const frame = readMp3Frame(bytes, i);
    if (!frame || frame.length < 4) {
      i++; // resynchronise
      continue;
    }
    // A Xing/Info header frame carries metadata, not audio.
    const isInfoFrame =
      first && /Xing|Info/.test(ascii(bytes, i + 4, Math.min(frame.length - 4, 40)));
    if (!isInfoFrame) seconds += frame.samples / frame.sampleRate;
    first = false;
    i += frame.length;
  }
  return seconds;
}

/** Seconds of audio in `bytes`, in the given format. */
export function audioDuration(bytes: Uint8Array, format: OutputFormat): number {
  const wav = parseWav(bytes);
  if (wav) return wav.dataBytes / wav.blockAlign / wav.sampleRate;
  if (format.container === 'raw') {
    const size = bytesPerSample(format.encoding);
    return size ? bytes.byteLength / size / (format.sample_rate ?? DEFAULT_SAMPLE_RATE) : 0;
  }
  return mp3Duration(bytes);
}

/** Rounds seconds to milliseconds for reporting. */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
