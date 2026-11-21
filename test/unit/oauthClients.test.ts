import { describe, expect, it } from 'vitest';

import { ClientMetadataResolver } from '../../src/http/oauth/cimd.js';
import {
  ClientError,
  cleanName,
  isAllowedRedirectUri,
  openRegisteredClient,
  redirectMatches,
  registerClient,
  resolveClient,
} from '../../src/http/oauth/clients.js';
import { Sealer } from '../../src/http/sealer.js';

const sealer = Sealer.fromSecret('s'.repeat(48));

describe('redirect URIs', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['http://127.0.0.1:33418/callback', true],
    ['http://localhost/callback', true],
    ['http://[::1]:9000/cb', true],
    ['http://example.com/cb', false],
    ['cursor://anysphere.cursor-mcp/oauth/callback', false],
    ['https://claude.ai/cb#frag', false],
    ['https://user:pw@claude.ai/cb', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s allowed: %s', (uri, allowed) => {
    expect(isAllowedRedirectUri(uri)).toBe(allowed);
  });

  it('matches exactly, except the port of a loopback redirect', () => {
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback',
      ),
    ).toBe(true);
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback/',
      ),
    ).toBe(false);
    expect(redirectMatches('https://claude.ai/cb', 'https://claude.ai:8443/cb')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'http://localhost:51234/callback')).toBe(
      true,
    );
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:5000/other')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://localhost:5000/callback')).toBe(
      false,
    );
    expect(redirectMatches('http://127.0.0.1/callback', 'https://127.0.0.1:5000/callback')).toBe(
      false,
    );
  });
});

describe('dynamic client registration', () => {
  it('seals the metadata into the client id and returns RFC 7591 fields', () => {
    const reg = registerClient(sealer, {
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    expect(reg).toMatchObject({
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    });
    expect(reg.client_secret).toBeUndefined();
    expect(openRegisteredClient(sealer, reg.client_id)).toEqual({
      clientId: reg.client_id,
      name: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      authMethod: 'none',
    });
  });

  it('issues a stateless secret to confidential clients', () => {
    const reg = registerClient(sealer, {
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(reg.client_secret).toBeDefined();
    expect(sealer.verifyClientSecret(reg.client_id, reg.client_secret!)).toBe(true);
    expect(reg.client_name).toBe('An app at app.example');
  });

  it.each([
    [{}, 'invalid_redirect_uri'],
    [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: Array(6).fill('https://a.example/cb') }, 'invalid_redirect_uri'],
    [
      { redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'private_key_jwt' },
      'invalid_client_metadata',
    ],
    [
      { redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] },
      'invalid_client_metadata',
    ],
    [
      { redirect_uris: ['https://a.example/cb'], response_types: ['token'] },
      'invalid_client_metadata',
    ],
  ])('refuses %j', (metadata, code) => {
    try {
      registerClient(sealer, metadata);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect((error as ClientError).code).toBe(code);
    }
  });

  it('cleans display names', () => {
    expect(cleanName('  Evil‮ App\n\t ')).toBe('Evil App');
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
    expect(cleanName(42)).toBeUndefined();
  });
});

describe('client id metadata documents', () => {
  const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
  const doc = {
    client_id: url,
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  };

  it('resolves a CIMD client and caches the document', async () => {
    let fetches = 0;
    const resolver = new ClientMetadataResolver(() => {
      fetches++;
      return Promise.resolve({ body: JSON.stringify(doc), maxAgeSeconds: undefined });
    });
    const client = await resolveClient(sealer, resolver, url);
    expect(client).toEqual({
      clientId: url,
      name: 'Claude',
      redirectUris: doc.redirect_uris,
      authMethod: 'none',
    });
    await resolveClient(sealer, resolver, url);
    expect(fetches).toBe(1);
  });

  it('refuses documents whose client_id differs, or that want a secret', async () => {
    const wrongId = new ClientMetadataResolver(() =>
      Promise.resolve({
        body: JSON.stringify({ ...doc, client_id: 'https://other.example/x' }),
        maxAgeSeconds: 60,
      }),
    );
    await expect(resolveClient(sealer, wrongId, url)).rejects.toThrow(/does not match/);
    const secret = new ClientMetadataResolver(() =>
      Promise.resolve({
        body: JSON.stringify({ ...doc, token_endpoint_auth_method: 'client_secret_basic' }),
        maxAgeSeconds: 60,
      }),
    );
    await expect(resolveClient(sealer, secret, url)).rejects.toThrow(ClientError);
  });

  it('refuses client ids that are neither sealed nor fetchable', async () => {
    const resolver = new ClientMetadataResolver(() => Promise.reject(new Error('must not fetch')));
    for (const id of [
      'random',
      'http://claude.ai/x',
      'https://claude.ai:8443/x',
      'https://claude.ai/',
      'https://u:p@claude.ai/x',
    ]) {
      await expect(resolveClient(sealer, resolver, id)).rejects.toThrow(/Unknown client_id/);
    }
  });
});
