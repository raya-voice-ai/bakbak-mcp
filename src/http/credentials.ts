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

interface Verdict {
  check: 'valid' | 'invalid';
  until: number;
}

export interface KeyCheckerOptions {
  /** How long a valid key is believed without asking again. */
  validTtlMs?: number;
  /** How long a rejected key is refused without asking again. */
  invalidTtlMs?: number;
  /** Most verdicts remembered; the oldest are forgotten first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Checks keys with `GET /v1/voices` on a one-off client (`Backend.checkKey`),
 * so an unverified key never takes one of the backend's per-key client slots.
 * Verdicts are cached (valid for 10 minutes, rejected for 1 minute), and
 * concurrent checks of the same key share one request.
 */
export class KeyChecker {
  private readonly verdicts = new Map<string, Verdict>();
  private readonly pending = new Map<string, Promise<KeyCheck>>();
  private readonly validTtlMs: number;
  private readonly invalidTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly backend: Backend,
    private readonly voices: VoiceCache,
    options: KeyCheckerOptions = {},
  ) {
    this.validTtlMs = options.validTtlMs ?? 10 * 60_000;
    this.invalidTtlMs = options.invalidTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  /** The remembered verdict for this key, if any; never contacts the API. */
  cached(apiKey: string): KeyCheck | undefined {
    const verdict = this.verdicts.get(fingerprint(apiKey));
    return verdict && verdict.until > this.now() ? verdict.check : undefined;
  }

  private remember(id: string, check: 'valid' | 'invalid'): void {
    this.verdicts.delete(id);
    this.verdicts.set(id, {
      check,
      until: this.now() + (check === 'valid' ? this.validTtlMs : this.invalidTtlMs),
    });
    for (const oldest of this.verdicts.keys()) {
      if (this.verdicts.size <= this.maxEntries) break;
      this.verdicts.delete(oldest);
    }
  }

  /** The verdict for this key, asking the API when nothing is cached. */
  check(apiKey: string): Promise<KeyCheck> {
    const hit = this.cached(apiKey);
    if (hit) return Promise.resolve(hit);
    const id = fingerprint(apiKey);
    const running = this.pending.get(id);
    if (running) return running;
    const check = this.backend.checkKey(apiKey).then(
      (voices): KeyCheck => {
        this.remember(id, 'valid');
        this.voices.seed(apiKey, voices);
        return 'valid';
      },
      (error: unknown): KeyCheck => {
        const status = this.backend.describeError(error)?.status;
        if (status === 401 || status === 403) {
          this.remember(id, 'invalid');
          return 'invalid';
        }
        return 'unavailable';
      },
    );
    this.pending.set(id, check);
    void check.finally(() => this.pending.delete(id));
    return check;
  }
}
