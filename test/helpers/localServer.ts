/** Connects an in-memory MCP client to a local-mode server backed by the mock API. */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createSdkBackend } from '../../src/backend/sdk.js';
import type { Backend } from '../../src/backend/types.js';
import { createLocalDelivery } from '../../src/local/delivery.js';
import { silentLogger } from '../../src/log.js';
import { createBakbakServer } from '../../src/server.js';
import { VoiceCache } from '../../src/voices.js';
import { TEST_KEY } from './mockApi.js';

export interface LocalHarness {
  client: Client;
  backend: Backend;
  outputDir: string;
  close(): Promise<void>;
}

export async function connectLocal(
  baseURL: string,
  options: { apiKey?: string | undefined } = {},
): Promise<LocalHarness> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'bakbak-mcp-out-'));
  const backend = createSdkBackend({ baseURL, logger: silentLogger });
  const server = createBakbakServer({
    mode: 'local',
    backend,
    apiKey: 'apiKey' in options ? options.apiKey : TEST_KEY,
    voices: new VoiceCache(),
    delivery: createLocalDelivery(outputDir),
    logger: silentLogger,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    backend,
    outputDir,
    async close() {
      await client.close();
      await server.close();
      await backend.close();
    },
  };
}

/** The text of every text content block, joined. */
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}
