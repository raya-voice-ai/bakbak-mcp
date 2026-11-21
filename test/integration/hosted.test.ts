/**
 * Hosted mode end to end, with a scripted client that does what claude.ai does
 * for a custom connector: discovery → registration → authorization (form) →
 * token → MCP → tool call, then refresh and the failure cases.
 */

import { createHash, randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Sealer } from '../../src/http/sealer.js';
import { textOf } from '../helpers/localServer.js';
import { type HostedHarness, TEST_SECRET, startHosted } from '../helpers/hostedServer.js';
import { type MockApi, TEST_KEY, startMockApi } from '../helpers/mockApi.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CLAUDE_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

let api: MockApi;
let hosted: HostedHarness;
let base: string;

beforeAll(async () => {
  api = await startMockApi();
  hosted = await startHosted(api.baseURL, {
    documents: (url) =>
      url.href === CLAUDE_CIMD
        ? Promise.resolve({
            body: JSON.stringify({
              client_id: CLAUDE_CIMD,
              client_name: 'Claude',
              redirect_uris: [CLAUDE_CALLBACK],
              grant_types: ['authorization_code', 'refresh_token'],
              token_endpoint_auth_method: 'none',
            }),
            maxAgeSeconds: 3600,
          })
        : Promise.reject(new Error('unexpected fetch')),
  });
  base = hosted.url;
});
afterAll(async () => {
  await hosted.close();
  await api.close();
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

async function register(redirectUris = [CLAUDE_CALLBACK]): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Authorized {
  code: string;
  state: string | null;
  iss: string | null;
  verifier: string;
}

/** GET the form, POST the key: what a person does in the browser. */
async function authorize(
  clientId: string,
  options: { apiKey?: string; redirectUri?: string } = {},
): Promise<Authorized> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri ?? CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: `${base}/mcp`,
  });
  const page = await fetch(`${base}/authorize?${query.toString()}`, { redirect: 'manual' });
  expect(page.status).toBe(200);
  const html = await page.text();
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
  const submitted = await fetch(`${base}/authorize`, {
    ...form({ request, csrf_token: csrf, api_key: options.apiKey ?? TEST_KEY, action: 'connect' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    redirect: 'manual',
  });
  expect(submitted.status).toBe(302);
  const location = new URL(submitted.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(options.redirectUri ?? CLAUDE_CALLBACK);
  expect(location.searchParams.get('state')).toBe(state);
  return {
    code: location.searchParams.get('code')!,
    state,
    iss: location.searchParams.get('iss'),
    verifier,
  };
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function exchange(
  clientId: string,
  auth: Authorized,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/token`, {
    ...form({
      grant_type: 'authorization_code',
      code: auth.code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: auth.verifier,
      client_id: clientId,
      resource: `${base}/mcp`,
      ...overrides,
    }),
  });
}

async function mcpClient(headers: Record<string, string>, modern = false): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: 'claude-ai-emulator', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return client;
}

describe('claude.ai connector flow', () => {
  let clientId: string;
  let tokens: Tokens;

  it('answers an unauthenticated MCP request with 401 and resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('publishes RFC 9728 and RFC 8414 metadata built from MCP_PUBLIC_URL', async () => {
    const prm = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
        headers: { Host: 'evil.example' },
      })
    ).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      client_id_metadata_document_supported: true,
    });
    expect(as.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('registers, authorizes with the API key, and exchanges the code (PKCE S256)', async () => {
    clientId = await register();
    const page = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' }).toString()}`,
    );
    const html = await page.text();
    expect(html).toContain('Connect Claude to Bakbak');
    expect(html).toContain('https://bakbak.getraya.app');
    expect(html).toMatch(/<label for="api_key">/);
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get('content-security-policy')).toContain('https://claude.ai');

    const auth = await authorize(clientId);
    expect(auth.iss).toBe(base);
    const res = await exchange(clientId, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    tokens = (await res.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tokens.access_token.startsWith('bkmat1.')).toBe(true);
    expect(tokens.access_token).not.toContain(TEST_KEY);

    // A code works once.
    expect((await exchange(clientId, auth)).status).toBe(400);
  });

  it('serves MCP with the access token (2025 initialize) and returns an audio link', async () => {
    const client = await mcpClient({ Authorization: `Bearer ${tokens.access_token}` });
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getInstructions()).toMatch(/download link/);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['list_voices', 'text_to_speech']);
      const tts = tools.find((t) => t.name === 'text_to_speech')!;
      expect(Object.keys(tts.inputSchema.properties ?? {})).not.toContain('output_path');
      const result = await client.callTool({
        name: 'text_to_speech',
        arguments: { text: 'नमस्ते', language: 'hi' },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      const out = result.structuredContent as {
        audio_url: string;
        expires_at: string;
        duration_seconds: number;
      };
      expect(out.audio_url).toMatch(new RegExp(`^${base}/audio/[A-Za-z0-9_-]{22}\\.wav$`));
      expect(Date.parse(out.expires_at) - Date.now()).toBeGreaterThan(59 * 60_000);
      expect(textOf(result)).toContain(out.audio_url);

      const audio = await fetch(out.audio_url);
      expect(audio.status).toBe(200);
      expect(audio.headers.get('content-type')).toBe('audio/wav');
      expect(audio.headers.get('cache-control')).toBe('private, no-store');
      expect(audio.headers.get('content-disposition')).toMatch(
        /^inline; filename="bakbak-.+\.wav"$/,
      );
      const bytes = Buffer.from(await audio.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');

      const ranged = await fetch(out.audio_url, { headers: { Range: 'bytes=0-3' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${bytes.byteLength}`);
      expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe('RIFF');
    } finally {
      await client.close();
    }
  });

  it('serves the 2026-07-28 stateless protocol too (server/discover)', async () => {
    const client = await mcpClient({ Authorization: `Bearer ${tokens.access_token}` }, true);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getInstructions()).toMatch(/list_voices/);
      const result = await client.callTool({ name: 'list_voices', arguments: { language: 'hi' } });
      expect((result.structuredContent as { total: number }).total).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('refreshes tokens and the new access token works', async () => {
    const res = await fetch(
      `${base}/token`,
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    );
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as Tokens;
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const client = await mcpClient({ Authorization: `Bearer ${refreshed.access_token}` });
    await client.listTools();
    await client.close();
    // A refresh token belongs to its client.
    const other = await register();
    expect(
      (
        await fetch(
          `${base}/token`,
          form({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: other,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('rejects an expired access token with invalid_token', async () => {
    const sealer = Sealer.fromSecret(TEST_SECRET);
    const expired = sealer.seal('access', {
      k: TEST_KEY,
      c: 'x',
      res: `${base}/mcp`,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${expired}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(
      /^Bearer error="invalid_token", resource_metadata=/,
    );
  });

  it('rejects a tampered token, and refresh tokens used as access tokens', async () => {
    const parts = tokens.access_token.split('.');
    const data = parts[2]!;
    const tampered = `${parts[0]}.${parts[1]}.${data.slice(0, 10)}${data[10] === 'A' ? 'B' : 'A'}${data.slice(11)}`;
    for (const bad of [tampered, tokens.refresh_token]) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bad}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
  });

  it('refuses a wrong PKCE verifier', async () => {
    const auth = await authorize(clientId);
    const res = await exchange(clientId, auth, { code_verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringMatching(/PKCE/),
    });
  });

  it('refuses a redirect_uri mismatch at /authorize and at /token', async () => {
    const page = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' }).toString()}`,
      { redirect: 'manual' },
    );
    expect(page.status).toBe(400);
    expect(page.headers.get('location')).toBeNull();
    const auth = await authorize(clientId);
    const res = await exchange(clientId, auth, { redirect_uri: 'https://claude.ai/other' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('requires PKCE S256 and the right resource', async () => {
    const plain = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain', state: 's1' }).toString()}`,
      { redirect: 'manual' },
    );
    expect(plain.status).toBe(302);
    const location = new URL(plain.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s1');
    const wrongResource = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' }).toString()}`,
      { redirect: 'manual' },
    );
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('shows the form again when the key is wrong, and refuses a forged form', async () => {
    const { challenge } = pkce();
    const page = await fetch(
      `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' }).toString()}`,
    );
    const html = await page.text();
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
    const wrong = await fetch(`${base}/authorize`, {
      ...form({ request, csrf_token: csrf, api_key: 'not-the-key', action: 'connect' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      redirect: 'manual',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toMatch(
      /did not accept that API key[\s\S]*role="alert"|role="alert"[\s\S]*did not accept that API key/,
    );
    const forged = await fetch(`${base}/authorize`, {
      ...form({ request, csrf_token: csrf, api_key: TEST_KEY, action: 'connect' }),
      redirect: 'manual',
    });
    expect(forged.status).toBe(403);
    const cancelled = await fetch(`${base}/authorize`, {
      ...form({ request, csrf_token: csrf, action: 'cancel' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      redirect: 'manual',
    });
    expect(new URL(cancelled.headers.get('location')!).searchParams.get('error')).toBe(
      'access_denied',
    );
  });

  it("accepts claude.ai's client ID metadata document instead of registration", async () => {
    const auth = await authorize(CLAUDE_CIMD);
    const res = await exchange(CLAUDE_CIMD, auth);
    expect(res.status).toBe(200);
  });
});

describe('API key headers (Claude Code, Cursor, VS Code)', () => {
  it('accepts a raw key as a Bearer token or X-API-Key', async () => {
    const headerSets: Record<string, string>[] = [
      { Authorization: `Bearer ${TEST_KEY}` },
      { 'X-API-Key': TEST_KEY },
    ];
    for (const headers of headerSets) {
      const client = await mcpClient(headers);
      const result = await client.callTool({ name: 'list_voices', arguments: { limit: 1 } });
      expect((result.structuredContent as { count: number }).count).toBe(1);
      await client.close();
    }
  });

  it('answers a wrong key with 401 so the client can authenticate', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': 'wrong', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });
});

describe('operations', () => {
  it('answers CORS preflights for browser-based clients', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://inspector.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, mcp-method, mcp-param-text',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'authorization, content-type, mcp-method, mcp-param-text',
    );
    expect(res.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('has a health check', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('404s unknown audio', async () => {
    expect((await fetch(`${base}/audio/${'a'.repeat(22)}.wav`)).status).toBe(404);
    expect((await fetch(`${base}/audio/../package.json`)).status).toBe(404);
  });

  it('rate-limits registration per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
