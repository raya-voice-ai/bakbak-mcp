/**
 * Authorization codes, access tokens and refresh tokens, all sealed blobs
 * carrying the user's Bakbak API key, the client they were issued to, the
 * resource they are for and an expiry. Nothing is stored server-side.
 *
 * Codes are single-use per instance (an in-memory set of redeemed codes
 * until they expire), and are marked used only once fully validated; across
 * instances PKCE still ties a code to the client that started the flow.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Sealer } from '../sealer.js';

export const CODE_TTL_S = 60;
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;

export interface CodeGrant {
  apiKey: string;
  clientHash: string;
  redirectUri: string;
  /** Whether the authorization request carried redirect_uri explicitly. */
  redirectPresented: boolean;
  codeChallenge: string;
  resource: string;
  scope: string | undefined;
}

/** A code opened at the token endpoint, not yet marked used. */
export interface OpenedCode extends CodeGrant {
  jti: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export interface TokenGrant {
  apiKey: string;
  clientHash: string;
  resource: string;
  scope: string | undefined;
  /** Expiry, seconds since the epoch. */
  expiresAt: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `BASE64URL(SHA256(verifier))`, the S256 transform. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
export function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

/** A well-formed S256 challenge: 43 base64url characters. */
export function isValidChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export class TokenIssuer {
  private readonly redeemed = new Map<string, number>();

  constructor(
    private readonly sealer: Sealer,
    private readonly clock: () => number = nowSeconds,
  ) {}

  issueCode(grant: CodeGrant): string {
    return this.sealer.seal('code', {
      k: grant.apiKey,
      c: grant.clientHash,
      ru: grant.redirectUri,
      cc: grant.codeChallenge,
      ...(grant.redirectPresented && { rp: 1 }),
      res: grant.resource,
      ...(grant.scope !== undefined && { s: grant.scope }),
      jti: randomBytes(12).toString('base64url'),
      exp: this.clock() + CODE_TTL_S,
    });
  }

  /** Opens a code without using it up. Undefined if invalid, expired or already used here. */
  openCode(code: string): OpenedCode | undefined {
    const data = this.sealer.open('code', code);
    const exp = data?.exp;
    const jti = str(data?.jti);
    const now = this.clock();
    if (!data || typeof exp !== 'number' || exp <= now || !jti) return undefined;
    this.forgetExpired(now);
    if (this.redeemed.has(jti)) return undefined;
    const apiKey = str(data.k);
    const clientHash = str(data.c);
    const redirectUri = str(data.ru);
    const codeChallenge = str(data.cc);
    const resource = str(data.res);
    if (!apiKey || !clientHash || !redirectUri || !codeChallenge || !resource) return undefined;
    return {
      apiKey,
      clientHash,
      redirectUri,
      redirectPresented: data.rp === 1,
      codeChallenge,
      resource,
      scope: str(data.s),
      jti,
      exp,
    };
  }

  /** Marks a fully validated code used. False if it already was (a replay). */
  markRedeemed(code: OpenedCode): boolean {
    if (this.redeemed.has(code.jti)) return false;
    this.redeemed.set(code.jti, code.exp);
    return true;
  }

  private forgetExpired(now: number): void {
    for (const [jti, exp] of this.redeemed) {
      if (exp <= now) this.redeemed.delete(jti);
    }
  }

  /** A new access token and refresh token for this grant. */
  issueTokens(grant: Omit<TokenGrant, 'expiresAt'>): TokenResponse {
    const now = this.clock();
    const base = {
      k: grant.apiKey,
      c: grant.clientHash,
      res: grant.resource,
      ...(grant.scope !== undefined && { s: grant.scope }),
    };
    return {
      access_token: this.sealer.seal('access', { ...base, exp: now + ACCESS_TTL_S }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: this.sealer.seal('refresh', { ...base, exp: now + REFRESH_TTL_S }),
      ...(grant.scope !== undefined && { scope: grant.scope }),
    };
  }

  private openToken(kind: 'access' | 'refresh', token: string): TokenGrant | undefined {
    const data = this.sealer.open(kind, token);
    const exp = data?.exp;
    if (!data || typeof exp !== 'number' || exp <= this.clock()) return undefined;
    const apiKey = str(data.k);
    const clientHash = str(data.c);
    const resource = str(data.res);
    if (!apiKey || !clientHash || !resource) return undefined;
    return { apiKey, clientHash, resource, scope: str(data.s), expiresAt: exp };
  }

  verifyAccessToken(token: string): TokenGrant | undefined {
    return this.openToken('access', token);
  }

  verifyRefreshToken(token: string): TokenGrant | undefined {
    return this.openToken('refresh', token);
  }
}
