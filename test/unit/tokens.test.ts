import { describe, expect, it } from 'vitest';

import {
  CODE_TTL_S,
  TokenIssuer,
  isValidChallenge,
  isValidVerifier,
  pkceChallenge,
} from '../../src/http/oauth/tokens.js';
import { Sealer } from '../../src/http/sealer.js';

const sealer = Sealer.fromSecret('t'.repeat(48));

function issuer(start = 1_000_000) {
  const clock = { now: start };
  return { tokens: new TokenIssuer(sealer, () => clock.now), clock };
}

const grant = {
  apiKey: 'bk_live_secret',
  clientHash: 'c'.repeat(22),
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  codeChallenge: pkceChallenge('v'.repeat(43)),
  resource: 'https://mcp.example/mcp',
  scope: undefined,
};

describe('TokenIssuer', () => {
  it('redeems a code once', () => {
    const { tokens } = issuer();
    const code = tokens.issueCode(grant);
    expect(code).not.toContain(grant.apiKey);
    expect(tokens.redeemCode(code)).toEqual(grant);
    expect(tokens.redeemCode(code)).toBeUndefined();
  });

  it('expires codes after 60 s', () => {
    const { tokens, clock } = issuer();
    const code = tokens.issueCode(grant);
    clock.now += CODE_TTL_S;
    expect(tokens.redeemCode(code)).toBeUndefined();
  });

  it('issues access tokens for an hour and refresh tokens for 30 days', () => {
    const { tokens, clock } = issuer();
    const issued = tokens.issueTokens(grant);
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tokens.verifyAccessToken(issued.access_token)?.apiKey).toBe(grant.apiKey);
    expect(tokens.verifyAccessToken(issued.refresh_token)).toBeUndefined();
    expect(tokens.verifyRefreshToken(issued.access_token)).toBeUndefined();
    clock.now += 3600;
    expect(tokens.verifyAccessToken(issued.access_token)).toBeUndefined();
    expect(tokens.verifyRefreshToken(issued.refresh_token)?.clientHash).toBe(grant.clientHash);
    clock.now += 30 * 24 * 3600;
    expect(tokens.verifyRefreshToken(issued.refresh_token)).toBeUndefined();
  });
});

describe('PKCE', () => {
  it('implements S256 (RFC 7636 appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('validates verifier and challenge syntax', () => {
    expect(isValidVerifier('a'.repeat(42))).toBe(false);
    expect(isValidVerifier('a'.repeat(43))).toBe(true);
    expect(isValidVerifier('a'.repeat(129))).toBe(false);
    expect(isValidVerifier(`${'a'.repeat(43)} `)).toBe(false);
    expect(isValidChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(isValidChallenge('plain')).toBe(false);
  });
});
