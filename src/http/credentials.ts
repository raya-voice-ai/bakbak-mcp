/**
 * Who is calling `/mcp`. Three ways to present a Bakbak API key:
 *
 * - `Authorization: Bearer <access token>` issued by this server's OAuth flow;
 * - `Authorization: Bearer <Bakbak API key>` (Claude Code, Cursor, VS Code headers);
 * - `X-API-Key: <Bakbak API key>`.
 *
 * Raw keys are checked against the API (`GET /v1/voices`, free) and the answer
 * cached, so a wrong key gets a 401 that tells the client to authenticate.
 */

import type { IncomingMessage } from 'node:http';

import type { Backend } from '../backend/types.js';
import { fingerprint } from '../util.js';
import type { VoiceCache } from '../voices.js';
import { header } from './io.js';
import type { KeyCheck } from './oauth/server.js';
import type { TokenIssuer } from './oauth/tokens.js';
import { SEALED_PREFIX, Sealer } from './sealer.js';

export type CredentialResult =
  | { ok: true; apiKey: string; via: 'oauth' | 'bearer' | 'x-api-key'; client: string | undefined }
  | { ok: false; error: 'missing' | 'invalid_token' };

const ACCESS_PREFIX = `${SEALED_PREFIX.access}.`;

/** Reads the credential from the request; does not contact the API. */
export function readCredential(
  req: IncomingMessage,
  tokens: TokenIssuer,
  resourceUrl: string,
): CredentialResult {
  const authorization = header(req, 'authorization')?.trim();
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    const token = match?.[1];
    if (!token) return { ok: false, error: 'invalid_token' };
    if (token.startsWith(ACCESS_PREFIX)) {
      const grant = tokens.verifyAccessToken(token);
      if (!grant || grant.resource !== resourceUrl) return { ok: false, error: 'invalid_token' };
      return { ok: true, apiKey: grant.apiKey, via: 'oauth', client: grant.clientHash };
    }
    // Codes, refresh tokens and client ids are never valid bearer credentials.
    if (Sealer.isSealed(token)) return { ok: false, error: 'invalid_token' };
    return { ok: true, apiKey: token, via: 'bearer', client: undefined };
  }
  const apiKey = header(req, 'x-api-key')?.trim();
  if (apiKey) return { ok: true, apiKey, via: 'x-api-key', client: undefined };
  return { ok: false, error: 'missing' };
}

/**
 * Checks keys with `GET /v1/voices` (which also warms the voice cache).
 * Rejections are remembered for a minute so a wrong key cannot drive traffic.
 */
export class KeyChecker {
  private readonly rejected = new Map<string, number>();

  constructor(
    private readonly backend: Backend,
    private readonly voices: VoiceCache,
    private readonly rejectionTtlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(apiKey: string): Promise<KeyCheck> {
    const id = fingerprint(apiKey);
    const now = this.now();
    const rejectedUntil = this.rejected.get(id);
    if (rejectedUntil !== undefined && rejectedUntil > now) return 'invalid';
    try {
      await this.voices.get(apiKey, () => this.backend.client(apiKey).listVoices());
      this.rejected.delete(id);
      return 'valid';
    } catch (error) {
      const status = this.backend.describeError(error)?.status;
      if (status === 401 || status === 403) {
        if (this.rejected.size > 10_000) this.rejected.clear();
        this.rejected.set(id, now + this.rejectionTtlMs);
        return 'invalid';
      }
      return 'unavailable';
    }
  }
}
