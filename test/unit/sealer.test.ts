import { describe, expect, it } from 'vitest';

import { SecretConfigError, Sealer, parseSecrets } from '../../src/http/sealer.js';

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);

describe('Sealer', () => {
  it('round-trips a payload and binds it to its kind', () => {
    const sealer = Sealer.fromSecret(SECRET_A);
    const blob = sealer.seal('access', { k: 'key', exp: 1 });
    expect(blob.startsWith('bkmat1.')).toBe(true);
    expect(blob).not.toContain('key');
    expect(sealer.open('access', blob)).toEqual({ k: 'key', exp: 1 });
    expect(sealer.open('refresh', blob)).toBeUndefined();
    // Even with the prefix rewritten, the associated data no longer matches.
    expect(sealer.open('refresh', blob.replace('bkmat1.', 'bkmrt1.'))).toBeUndefined();
  });

  it('rejects tampered blobs', () => {
    const sealer = Sealer.fromSecret(SECRET_A);
    const blob = sealer.seal('code', { x: 1 });
    const data = blob.split('.')[2]!;
    const flipped = data.slice(0, 20) + (data[20] === 'A' ? 'B' : 'A') + data.slice(21);
    expect(sealer.open('code', blob.replace(data, flipped))).toBeUndefined();
    expect(sealer.open('code', blob + 'x')).toBeUndefined();
    expect(sealer.open('code', 'bkmac1.nope.AAAA')).toBeUndefined();
    expect(sealer.open('code', 'garbage')).toBeUndefined();
  });

  it('rotates: the first secret seals, every listed secret opens', () => {
    const old = Sealer.fromSecret(`k1:${SECRET_A}`);
    const blob = old.seal('refresh', { v: 1 });
    const rotated = Sealer.fromSecret(`k2:${SECRET_B},k1:${SECRET_A}`);
    expect(rotated.open('refresh', blob)).toEqual({ v: 1 });
    expect(rotated.seal('refresh', { v: 2 }).split('.')[1]).toBe('k2');
    expect(Sealer.fromSecret(`k2:${SECRET_B}`).open('refresh', blob)).toBeUndefined();
  });

  it('derives a stable key id for a bare secret', () => {
    const [key] = parseSecrets(SECRET_A);
    expect(key?.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(parseSecrets(SECRET_A)[0]?.kid).toBe(key?.kid);
  });

  it('refuses short or duplicate secrets', () => {
    expect(() => parseSecrets('short')).toThrow(SecretConfigError);
    expect(() => parseSecrets(`k:${SECRET_A} k:${SECRET_B}`)).toThrow(/duplicate/);
    expect(() => parseSecrets('  ')).toThrow(SecretConfigError);
  });

  it('issues verifiable stateless client secrets', () => {
    const sealer = Sealer.fromSecret(SECRET_A);
    const clientId = sealer.seal('client', { n: 'x' });
    const secret = sealer.clientSecret(clientId)!;
    expect(sealer.verifyClientSecret(clientId, secret)).toBe(true);
    expect(sealer.verifyClientSecret(clientId, secret.slice(1))).toBe(false);
    expect(Sealer.fromSecret(SECRET_B).verifyClientSecret(clientId, secret)).toBe(false);
  });

  it('recognises its own blob prefixes', () => {
    expect(Sealer.isSealed('bkmrt1.k.x')).toBe(true);
    expect(Sealer.isSealed('sk_live_123')).toBe(false);
  });
});
