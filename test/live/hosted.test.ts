/** The hosted flow (OAuth and API-key headers) against a locally running HTTP server and a real API. */

import { createHash, randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type HostedHarness, startHosted } from '../helpers/hostedServer.js';
import { textOf } from '../helpers/localServer.js';
import { LIVE, LIVE_BASE_URL, LIVE_KEY, decodeWav } from './env.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe.skipIf(!LIVE)('live: hosted mode', () => {
  let hosted: HostedHarness;
  beforeAll(async () => {
    hosted = await startHosted(LIVE_BASE_URL);
  });
  afterAll(async () => {
    await hosted.close();
  });

  async function connect(headers: Record<string, string>): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${hosted.url}/mcp`), {
      requestInit: { headers },
    });
    const client = new Client({ name: 'live-hosted', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('connects through OAuth with the real key and returns a downloadable WAV', async () => {
    const base = hosted.url;
    const registered = (await (
      await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: [CALLBACK],
          token_endpoint_auth_method: 'none',
        }),
      })
    ).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'live',
      resource: `${base}/mcp`,
    });
    const page = await fetch(`${base}/authorize?${query.toString()}`);
    const html = await page.text();
    const submitted = await fetch(`${base}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: page.headers.get('set-cookie')!.split(';')[0]!,
      },
      body: new URLSearchParams({
        request: /name="request" value="([^"]+)"/.exec(html)![1]!,
        csrf_token: /name="csrf_token" value="([^"]+)"/.exec(html)![1]!,
        api_key: LIVE_KEY,
        action: 'connect',
      }).toString(),
    });
    expect(submitted.status).toBe(302);
    const code = new URL(submitted.headers.get('location')!).searchParams.get('code')!;
    const tokens = (await (
      await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: CALLBACK,
          code_verifier: verifier,
          client_id: registered.client_id,
        }).toString(),
      })
    ).json()) as { access_token: string };

    const client = await connect({ Authorization: `Bearer ${tokens.access_token}` });
    try {
      const result = await client.callTool({
        name: 'text_to_speech',
        arguments: { text: 'नमस्ते दोस्तों।', language: 'hi' },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      const out = result.structuredContent as { audio_url: string; duration_seconds: number };
      const audio = await fetch(out.audio_url);
      expect(audio.headers.get('content-type')).toBe('audio/wav');
      const wav = decodeWav(new Uint8Array(await audio.arrayBuffer()));
      expect(wav.seconds).toBeCloseTo(out.duration_seconds, 2);
      expect(wav.rms).toBeGreaterThan(50);
    } finally {
      await client.close();
    }
  });

  it('accepts the real key as X-API-Key and refuses a wrong one', async () => {
    const client = await connect({ 'X-API-Key': LIVE_KEY });
    const voices = await client.callTool({ name: 'list_voices', arguments: { limit: 3 } });
    expect((voices.structuredContent as { count: number }).count).toBe(3);
    await client.close();
    const res = await fetch(`${hosted.url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': 'definitely-not-a-key', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
