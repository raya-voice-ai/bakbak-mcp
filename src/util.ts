import { createHash, randomBytes } from 'node:crypto';

/** Length in Unicode code points, the unit every Bakbak limit is measured in. */
export function codePointLength(text: string): number {
  let surrogatePairs = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        surrogatePairs++;
        i++;
      }
    }
  }
  return text.length - surrogatePairs;
}

/** A short, non-reversible fingerprint of a secret for logs and map keys. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `length` characters of `[a-z0-9]` from a CSPRNG, without modulo bias. */
export function randomAlphanumeric(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 252 = 7 * 36: reject the top values so every character is equally likely.
      if (byte < 252) out += ALPHANUM.charAt(byte % 36);
      if (out.length === length) break;
    }
  }
  return out;
}

/** Base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/** Decodes base64url; returns undefined for anything that is not strictly base64url. */
export function fromBase64url(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  return Buffer.from(text, 'base64url');
}

/** Concatenates byte arrays into one, copying once. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
