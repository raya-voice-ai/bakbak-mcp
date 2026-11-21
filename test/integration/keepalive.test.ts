/**
 * Proxies such as Cloudflare drop a response that is silent for about 100 s.
 * Hosted mode always answers MCP requests as SSE with keep-alive comments, so
 * a long text_to_speech call keeps the connection busy in both protocol eras.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { type HostedHarness, startHosted } from '../helpers/hostedServer.js';
import { type MockApi, TEST_KEY, startMockApi } from '../helpers/mockApi.js';

let api: MockApi;
let hosted: HostedHarness;

beforeAll(async () => {
  api = await startMockApi();
  hosted = await startHosted(api.baseURL, { keepAliveMs: 50 });
  api.delayMs = 400;
});
afterAll(async () => {
  await hosted.close();
  await api.close();
});

const CALL = {
  name: 'text_to_speech',
  arguments: { text: 'नमस्ते', language: 'hi', voice_id: 'v-hi-std-1', model: 'standard' },
};

it('sends keep-alive comments before the result of a slow 2025-era call', async () => {
  const res = await fetch(`${hosted.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: CALL }),
  });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const body = await res.text();
  const result = body.indexOf('"result"');
  expect(result).toBeGreaterThan(0);
  expect(body.slice(0, result).match(/^:/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
});

it('sends keep-alive comments on 2026-07-28 calls', async () => {
  // Copy each response body as the client reads it.
  const bodies: string[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.body) return res;
    const index = bodies.push('') - 1;
    const decoder = new TextDecoder();
    const copy = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bodies[index] = (bodies[index] ?? '') + decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(copy), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${hosted.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_KEY}` } },
    fetch: recordingFetch,
  });
  const client = new Client(
    { name: 'keepalive', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  const result = await client.callTool(CALL);
  expect(result.isError).toBeFalsy();
  await client.close();
  const call = bodies.find((t) => t.includes('audio_url'));
  expect(call).toBeDefined();
  expect(
    call!.slice(0, call!.indexOf('audio_url')).match(/^:/gm)?.length ?? 0,
  ).toBeGreaterThanOrEqual(3);
});
