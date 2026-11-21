/**
 * Sealed blobs: AES-256-GCM encrypted, authenticated JSON. Client ids, pending
 * authorization requests, codes, access tokens and refresh tokens are all
 * sealed blobs, so the server keeps no database and any instance holding
 * `MCP_TOKEN_SECRET` can verify what another issued.
 *
 * Format: `<prefix>.<kid>.<base64url(iv ‖ ciphertext ‖ tag)>`. The prefix names
 * the kind of blob and, with the key id, is bound in as associated data, so a
 * blob of one kind never opens as another. Several secrets may be configured;
 * the first seals, all open, which allows rotation.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { base64url, fromBase64url } from '../util.js';

/** Blob kinds and their prefixes. Access and refresh prefixes help secret scanners. */
export const SEALED_PREFIX = {
  client: 'bkmc1',
  request: 'bkmq1',
  code: 'bkmac1',
  access: 'bkmat1',
  refresh: 'bkmrt1',
} as const;

export type SealedKind = keyof typeof SEALED_PREFIX;

interface SealingKey {
  kid: string;
  encryption: Buffer;
  hmac: Buffer;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SECRET_LENGTH = 32;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export class SecretConfigError extends Error {
  override readonly name = 'SecretConfigError';
}

function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'bakbak-mcp', info, 32));
}

/**
 * Parses `MCP_TOKEN_SECRET`: one or more entries separated by commas or
 * whitespace, each `<kid>:<secret>` or a bare secret (its key id is then a hash
 * of it). Secrets need at least 32 characters; `openssl rand -base64 48` makes one.
 */
export function parseSecrets(spec: string): SealingKey[] {
  const entries = spec.split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) throw new SecretConfigError('MCP_TOKEN_SECRET is empty.');
  const keys = entries.map((entry): SealingKey => {
    const colon = entry.indexOf(':');
    const hasKid = colon > 0 && KID_PATTERN.test(entry.slice(0, colon));
    const secret = hasKid ? entry.slice(colon + 1) : entry;
    const kid = hasKid
      ? entry.slice(0, colon)
      : createHash('sha256').update(secret).digest('hex').slice(0, 8);
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new SecretConfigError(
        `Each MCP_TOKEN_SECRET entry needs at least ${MIN_SECRET_LENGTH} characters (try: openssl rand -base64 48).`,
      );
    }
    return {
      kid,
      encryption: deriveKey(secret, 'sealed-blob-v1'),
      hmac: deriveKey(secret, 'client-secret-v1'),
    };
  });
  const kids = new Set(keys.map((k) => k.kid));
  if (kids.size !== keys.length)
    throw new SecretConfigError('MCP_TOKEN_SECRET has duplicate key ids.');
  return keys;
}

export class Sealer {
  private readonly current: SealingKey;
  private readonly byKid: Map<string, SealingKey>;

  constructor(keys: readonly SealingKey[]) {
    const [first] = keys;
    if (!first) throw new SecretConfigError('No sealing keys.');
    this.current = first;
    this.byKid = new Map(keys.map((k) => [k.kid, k]));
  }

  static fromSecret(spec: string): Sealer {
    return new Sealer(parseSecrets(spec));
  }

  /** Seals `payload` as a blob of `kind`. */
  seal(kind: SealedKind, payload: object): string {
    const prefix = SEALED_PREFIX[kind];
    const key = this.current;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key.encryption, iv);
    cipher.setAAD(Buffer.from(`${prefix}.${key.kid}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return `${prefix}.${key.kid}.${base64url(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
  }

  /** Opens a blob of `kind`; undefined if it is of another kind, tampered, or sealed with an unknown key. */
  open(kind: SealedKind, blob: string): Record<string, unknown> | undefined {
    const parts = blob.split('.');
    if (parts.length !== 3) return undefined;
    const [prefix, kid = '', data = ''] = parts;
    if (prefix !== SEALED_PREFIX[kind]) return undefined;
    const key = this.byKid.get(kid);
    const raw = fromBase64url(data);
    if (!key || !raw || raw.byteLength < IV_BYTES + TAG_BYTES + 2) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.encryption, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(`${prefix}.${kid}`));
      decipher.setAuthTag(raw.subarray(raw.byteLength - TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES, raw.byteLength - TAG_BYTES)),
        decipher.final(),
      ]);
      const value: unknown = JSON.parse(plain.toString('utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** True if `blob` looks like any sealed blob this server issues (whether or not it opens). */
  static isSealed(blob: string): boolean {
    const prefix = blob.slice(0, blob.indexOf('.'));
    return Object.values<string>(SEALED_PREFIX).includes(prefix);
  }

  /** The stateless client secret for a registered (sealed) client id. */
  clientSecret(clientId: string): string | undefined {
    const kid = clientId.split('.')[1] ?? '';
    const key = this.byKid.get(kid);
    return key ? base64url(createHmac('sha256', key.hmac).update(clientId).digest()) : undefined;
  }

  /** Constant-time check of a presented client secret. */
  verifyClientSecret(clientId: string, presented: string): boolean {
    const expected = this.clientSecret(clientId);
    if (expected === undefined) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }
}
