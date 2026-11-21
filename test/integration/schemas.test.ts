/**
 * The tool surface is a public contract: its schemas are snapshotted, and the
 * README's tool reference must name exactly the registered tools and parameters.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { createSdkBackend } from '../../src/backend/sdk.js';
import type { Delivery } from '../../src/delivery.js';
import { silentLogger } from '../../src/log.js';
import { createBakbakServer } from '../../src/server.js';
import type { ServerMode } from '../../src/tools/errors.js';
import { VoiceCache } from '../../src/voices.js';

const unusedDelivery: Delivery = { begin: () => Promise.reject(new Error('unused')) };

async function listTools(mode: ServerMode) {
  const backend = createSdkBackend({ baseURL: 'http://127.0.0.1:9', logger: silentLogger });
  const server = createBakbakServer({
    mode,
    backend,
    apiKey: undefined,
    voices: new VoiceCache(),
    delivery: unusedDelivery,
    logger: silentLogger,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'schemas', version: '1.0.0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  await backend.close();
  return tools;
}

describe('tool schemas', () => {
  it.each(['local', 'hosted'] as const)('%s mode matches the snapshot', async (mode) => {
    expect(await listTools(mode)).toMatchSnapshot();
  });
});

describe('README tool reference', () => {
  const readme = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
  const section = readme.slice(
    readme.indexOf('\n## Tools'),
    readme.indexOf('\n## ', readme.indexOf('\n## Tools') + 1),
  );

  function documented(): Map<string, Set<string>> {
    const tools = new Map<string, Set<string>>();
    let current: Set<string> | undefined;
    let inParameterTable = false;
    for (const line of section.split('\n')) {
      const heading = /^### `(\w+)`/.exec(line);
      if (heading?.[1]) {
        current = new Set();
        tools.set(heading[1], current);
        continue;
      }
      if (/^\|\s*Parameter\s*\|/.test(line)) inParameterTable = true;
      else if (!line.startsWith('|')) inParameterTable = false;
      const row = /^\|\s*`(\w+)`\s*\|/.exec(line);
      if (inParameterTable && row?.[1] && current) current.add(row[1]);
    }
    return tools;
  }

  it('documents exactly the registered tools and parameters', async () => {
    const local = await listTools('local');
    const hosted = await listTools('hosted');
    const registered = new Map<string, Set<string>>();
    for (const tool of [...local, ...hosted]) {
      const params = registered.get(tool.name) ?? new Set<string>();
      for (const p of Object.keys(tool.inputSchema.properties ?? {})) params.add(p);
      registered.set(tool.name, params);
    }
    const docs = documented();
    expect([...docs.keys()].sort()).toEqual([...registered.keys()].sort());
    for (const [name, params] of registered) {
      expect([...(docs.get(name) ?? [])].sort(), name).toEqual([...params].sort());
    }
  });
});
