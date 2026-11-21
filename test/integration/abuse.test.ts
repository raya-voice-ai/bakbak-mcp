/**
 * Hosted mode under abuse, with the production rate limits: floods of wrong
 * keys, too many calls per key, and calls too large to serve.
 */

import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSdkBackend } from '../../src/backend/sdk.js';
import { silentLogger } from '../../src/log.js';
import { type HostedHarness, startHosted } from '../helpers/hostedServer.js';
import { textOf } from '../helpers/localServer.js';
import { type MockApi, TEST_KEY, startMockApi } from '../helpers/mockApi.js';

const SENTENCE = 'यह एक लंबा वाक्य है जो परीक्षण के लिए लिखा गया है।';
const LONG = Array.from({ length: 240 }, () => SENTENCE).join(' '); // three pieces

let api: MockApi;
beforeAll(async () => {
  api = await startMockApi();
});
afterAll(async () => {
  await api.close();
});
afterEach(() => {
  api.delayMs = 0;
});

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { 'X-API-Key': TEST_KEY } },
  });
  const client = new Client({ name: 'abuse', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function waitForWebSocketPiece(): Promise<void> {
  for (let i = 0; i < 300 && !api.synthesisRequests().some((r) => r.transport === 'ws'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a flood of wrong API keys', () => {
  let hosted: HostedHarness;
  beforeAll(async () => {
    hosted = await startHosted(api.baseURL, { maxClients: 3 });
  });
  afterAll(async () => {
    await hosted.close();
  });

  it('cannot disturb a call in flight, and stops costing API requests', async () => {
    api.requests.length = 0;
    api.delayMs = 300;
    const client = await connect(hosted.url);
    const call = client.callTool({
      name: 'text_to_speech',
      arguments: { text: LONG, language: 'hi' },
    });
    await waitForWebSocketPiece();

    const statuses: Record<number, number> = {};
    await Promise.all(
      Array.from({ length: 60 }, async () => {
        const res = await fetch(`${hosted.url}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${randomBytes(16).toString('hex')}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }),
    );
    expect(Object.keys(statuses).sort()).toEqual(['401', '429']);
    // Only the per-address burst of checks reached the API.
    const bogusChecks = api.requests.filter(
      (r) => r.path === '/v1/voices' && r.headers['x-api-key'] !== TEST_KEY,
    );
    expect(bogusChecks.length).toBeLessThanOrEqual(10);

    const result = await call;
    expect(result.isError, textOf(result)).toBeFalsy();
    await client.close();
  });
});

describe('the backend', () => {
  it('never evicts a client with a call in flight', async () => {
    const backend = createSdkBackend({ baseURL: api.baseURL, logger: silentLogger, maxClients: 1 });
    api.delayMs = 200;
    let bytes = 0;
    const streaming = backend.client(TEST_KEY).streamPieces(
      ['पहला वाक्य।', 'दूसरा वाक्य।'],
      {
        voice_id: 'v-hi-std-1',
        language: 'hi',
        output_format: { container: 'raw', encoding: 'pcm_s16le' },
      },
      (chunk) => {
        bytes += chunk.byteLength;
        return Promise.resolve();
      },
    );
    await waitForWebSocketPiece();
    for (const key of ['other-1', 'other-2', 'other-3']) backend.client(key);
    await expect(streaming).resolves.toMatchObject({
      requestIds: [expect.any(String), expect.any(String)],
    });
    expect(bytes).toBeGreaterThan(0);
    await backend.close();
  });
});

describe('per-key and size limits', () => {
  let hosted: HostedHarness;
  beforeAll(async () => {
    hosted = await startHosted(api.baseURL, {
      env: { TTS_CONCURRENCY_PER_KEY: '1', MAX_OUTPUT_BYTES: '100M' },
    });
  });
  afterAll(async () => {
    await hosted.close();
  });

  it('runs at most TTS_CONCURRENCY_PER_KEY calls at once per key', async () => {
    api.requests.length = 0;
    api.delayMs = 200;
    const client = await connect(hosted.url);
    const first = client.callTool({
      name: 'text_to_speech',
      arguments: { text: LONG, language: 'hi' },
    });
    await waitForWebSocketPiece();
    const second = await client.callTool({
      name: 'text_to_speech',
      arguments: { text: 'नमस्ते', language: 'hi' },
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/already running for this API key \(the limit is 1\)/);
    expect((await first).isError).toBeFalsy();
    api.delayMs = 0;
    const third = await client.callTool({
      name: 'text_to_speech',
      arguments: { text: 'नमस्ते', language: 'hi' },
    });
    expect(third.isError, textOf(third)).toBeFalsy();
    await client.close();
  });

  it('refuses up front a call whose output would be too large', async () => {
    api.requests.length = 0;
    const client = await connect(hosted.url);
    const result = await client.callTool({
      name: 'text_to_speech',
      arguments: {
        text: Array.from({ length: 900 }, () => SENTENCE).join(' '),
        language: 'hi',
        output_format: { container: 'wav', encoding: 'pcm_f32le', sample_rate: 24000 },
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/more than this server makes in one call.*mp3/s);
    expect(api.synthesisRequests()).toHaveLength(0);
    await client.close();
  });
});
