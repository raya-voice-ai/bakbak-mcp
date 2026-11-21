import { describe, expect, it } from 'vitest';

import { estimateOutputBytes } from '../../src/audio/format.js';
import { Admission, type Ticket } from '../../src/tools/admission.js';

const MB = 1024 * 1024;

describe('Admission', () => {
  const admission = () =>
    new Admission({ maxOutputBytes: 10 * MB, perKeyConcurrency: 2, inflightBytes: 25 * MB });

  it('refuses a call whose estimated output is too large, with advice', () => {
    const refused = admission().admit('k', 11 * MB);
    expect('refused' in refused && refused.refused.message).toMatch(
      /more than this server makes in one call/,
    );
    expect('refused' in refused && refused.refused.next_step).toMatch(/mp3/);
  });

  it('caps concurrent calls per key, and frees the slot on release', () => {
    const a = admission();
    const first = a.admit('k', MB) as Ticket;
    a.admit('k', MB);
    const third = a.admit('k', MB);
    expect('refused' in third && third.refused.message).toMatch(/already running for this API key/);
    expect('release' in a.admit('other', MB)).toBe(true);
    first.release();
    first.release(); // idempotent
    expect('release' in a.admit('k', MB)).toBe(true);
  });

  it('keeps a server-wide budget of bytes in flight', () => {
    const a = admission();
    a.admit('a', 10 * MB);
    a.admit('b', 10 * MB);
    const refused = a.admit('c', 10 * MB);
    expect('refused' in refused && refused.refused.message).toMatch(/busy/);
  });

  it('estimates generously from characters and format', () => {
    // 20,000 characters of 24 kHz f32: 20,000 × 0.15 s × 96,000 B/s ≈ 288 MB.
    expect(
      estimateOutputBytes(20_000, { container: 'wav', encoding: 'pcm_f32le', sample_rate: 24000 }),
    ).toBeGreaterThan(270 * MB);
    expect(estimateOutputBytes(1000, { container: 'mp3' })).toBeLessThan(
      estimateOutputBytes(1000, { container: 'wav', encoding: 'pcm_s16le' }),
    );
  });
});
