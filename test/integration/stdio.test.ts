/**
 * Local mode as an MCP client runs it: the bundled server (the same build as
 * the Claude Desktop bundle) spawned over stdio. stdout must carry only the
 * protocol; logs go to stderr as JSON and never contain the key.
 */

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bundleMcpbServer } from '../../scripts/bundle.mjs';
import { textOf } from '../helpers/localServer.js';
import { type MockApi, TEST_KEY, startMockApi } from '../helpers/mockApi.js';

let api: MockApi;
let bundle: string;

beforeAll(async () => {
  api = await startMockApi();
  // Exactly the Claude Desktop bundle's layout: server/index.js plus its package.json.
  const server = path.join(await mkdtemp(path.join(tmpdir(), 'bakbak-bundle-')), 'server');
  await bundleMcpbServer(server);
  bundle = path.join(server, 'index.js');
}, 60_000);
afterAll(async () => {
  await api.close();
});

async function spawnServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmpdir(),
      BAKBAK_BASE_URL: api.baseURL,
      LOG_LEVEL: 'debug',
      ...env,
    },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  const pipe = transport.stderr as PassThrough | null;
  pipe?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  return { client, stderr, errors };
}

describe('stdio (the bundled server)', () => {
  it('serves both tools and writes audio files', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'bakbak-stdio-out-'));
    const { client, stderr, errors } = await spawnServer({
      BAKBAK_API_KEY: TEST_KEY,
      BAKBAK_MCP_OUTPUT_DIR: outputDir,
    });
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
        'list_voices',
        'read_docs',
        'search_docs',
        'text_to_speech',
      ]);
      // The documentation is inside the bundle: no files to ship next to it.
      const docs = await client.callTool({ name: 'read_docs', arguments: { page: 'livekit' } });
      expect(textOf(docs)).toContain('livekit-plugins-bakbak');
      const result = await client.callTool({
        name: 'text_to_speech',
        arguments: { text: 'नमस्ते', language: 'hi' },
      });
      const filePath = (result.structuredContent as { file_path: string }).file_path;
      expect(path.dirname(filePath)).toBe(outputDir);
      expect(existsSync(filePath)).toBe(true);
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
    const lines = stderr.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(line).not.toContain(TEST_KEY);
      expect(line).not.toContain('नमस्ते');
    }
  });

  it('starts without a key, lists tools, and explains how to set one', async () => {
    const { client, errors } = await spawnServer({});
    try {
      expect((await client.listTools()).tools).toHaveLength(4);
      const result = await client.callTool({ name: 'list_voices', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/BAKBAK_API_KEY/);
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
  });
});
