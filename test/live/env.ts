/**
 * Live tests run against a real deployment and spend real credits. They read
 * BAKBAK_API_KEY and BAKBAK_BASE_URL and are skipped when either is unset.
 * They run one at a time (see vitest.config.ts): deployments may serve only one
 * request per model at once.
 */

import { parseWav } from '../../src/audio/format.js';

export const LIVE_KEY = process.env.BAKBAK_API_KEY ?? '';
export const LIVE_BASE_URL = process.env.BAKBAK_BASE_URL ?? '';
export const LIVE = LIVE_KEY !== '' && LIVE_BASE_URL !== '';

/** Seconds of audio in a 16-bit mono WAV, after checking that it decodes and is not silent. */
export function decodeWav(bytes: Uint8Array): { seconds: number; rms: number } {
  const info = parseWav(bytes);
  if (!info) throw new Error('not a WAV file');
  const start = bytes.byteLength - info.dataBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, info.dataBytes);
  let sum = 0;
  const samples = Math.floor(info.dataBytes / 2);
  for (let i = 0; i < samples; i++) sum += view.getInt16(i * 2, true) ** 2;
  return {
    seconds: info.dataBytes / info.blockAlign / info.sampleRate,
    rms: Math.sqrt(sum / Math.max(1, samples)),
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
