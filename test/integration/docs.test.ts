/**
 * The developer documentation surface: search_docs and read_docs, the
 * bakbak://docs/ resources and the prompts. All of it works without an API key
 * and without the API (the base URL here points nowhere).
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSdkBackend } from '../../src/backend/sdk.js';
import type { Delivery } from '../../src/delivery.js';
import { PAGES } from '../../src/knowledge/pages.generated.js';
import { silentLogger } from '../../src/log.js';
import { PROMPT_NAMES } from '../../src/prompts.js';
import { createBakbakServer } from '../../src/server.js';
import { VoiceCache } from '../../src/voices.js';
import { type LocalHarness, connectLocal, textOf } from '../helpers/localServer.js';

let h: LocalHarness;

beforeEach(async () => {
  h = await connectLocal('http://127.0.0.1:9', { apiKey: undefined });
});
afterEach(async () => {
  await h.close();
});

function call(name: string, args: Record<string, unknown>) {
  return h.client.callTool({ name, arguments: args });
}

describe('discovery', () => {
  it('lists the docs tools as read-only and closed-world', async () => {
    const { tools } = await h.client.listTools();
    for (const name of ['search_docs', 'read_docs']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description).toMatch(/LiveKit/);
      expect(tool.description).toMatch(/no API key/);
    }
  });

  it('tells the model to read the docs before writing integration code', () => {
    const instructions = h.client.getInstructions() ?? '';
    expect(instructions).toMatch(/read_docs/);
    expect(instructions).toMatch(/start-here/);
    expect(instructions).toMatch(/search_docs/);
    expect(instructions).toMatch(/LiveKit/);
  });
});

describe('read_docs', () => {
  it('returns the index without a page, and with no API key configured', async () => {
    const result = await call('read_docs', {});
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/^# Bakbak developer documentation/);
    for (const page of PAGES) expect(text).toContain(`\`${page.id}\``);
  });

  it('returns a whole page with its id and source', async () => {
    const text = textOf(await call('read_docs', { page: 'livekit' }));
    expect(text).toMatch(/^Page `livekit` · https:\/\/github\.com\/raya-voice-ai\/bakbak-mcp\//);
    expect(text).toContain('bakbak.TTS(');
    expect(text).toContain('pip install livekit-plugins-bakbak');
  });

  it('accepts aliases and returns one section', async () => {
    const text = textOf(
      await call('read_docs', { page: 'python', section: 'Retries and timeouts' }),
    );
    expect(text).toContain('section "Retries and timeouts"');
    expect(text).toMatch(/\n## Retries and timeouts\n/);
    expect(text).toContain('never retries');
    expect(text).not.toContain('## Raw responses');
  });

  it('suggests page ids for an unknown page', async () => {
    const result = await call('read_docs', { page: 'livekit plugin docs' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/livekit/);
  });

  it('lists the headings for an unknown section', async () => {
    const result = await call('read_docs', { page: 'telephony', section: 'Asterisk dialplan' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('- Formats and messages by provider');
  });

  it('refuses unknown arguments', async () => {
    const result = await call('read_docs', { page: 'errors', api_key: 'x' });
    expect(result.isError).toBe(true);
  });
});

describe('search_docs', () => {
  it('returns ranked sections with how to read them', async () => {
    const result = await call('search_docs', { query: 'twilio clear barge-in', limit: 3 });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/^3 sections match "twilio clear barge-in":/);
    expect(text).toMatch(/^1\. \S+ › /m);
    expect(text).toMatch(/read_docs \{"page":"telephony"/);
  });

  it('says when nothing matches', async () => {
    const text = textOf(await call('search_docs', { query: 'zzqx' }));
    expect(text).toMatch(/No sections match/);
  });

  it('validates the query and limit', async () => {
    expect((await call('search_docs', { query: '' })).isError).toBe(true);
    expect((await call('search_docs', { query: 'x', limit: 50 })).isError).toBe(true);
  });
});

describe('resources', () => {
  it('lists every page as bakbak://docs/<id> Markdown', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(
      PAGES.map((p) => `bakbak://docs/${p.id}`).sort(),
    );
    expect(resources.every((r) => r.mimeType === 'text/markdown')).toBe(true);
  });

  it('reads a page, examples included', async () => {
    const { contents } = await h.client.readResource({
      uri: 'bakbak://docs/examples/python/llm_streaming.py',
    });
    expect(contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((contents[0] as { text: string }).text).toContain('send_stream');
  });
});

describe('prompts', () => {
  it('lists the prompts', async () => {
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
  });

  it('integrate_bakbak points at the platform page and the right package', async () => {
    const { messages } = await h.client.getPrompt({
      name: 'integrate_bakbak',
      arguments: { platform: 'twilio', goal: 'a Hindi support line' },
    });
    const text = (messages[0]?.content as { text: string }).text;
    expect(text).toContain("'telephony'");
    expect(text).toContain('a Hindi support line');
    expect(text).toContain('list_voices');
    expect(text).toContain('BAKBAK_API_KEY');
  });

  it('integrate_bakbak without a platform starts from start-here', async () => {
    const { messages } = await h.client.getPrompt({ name: 'integrate_bakbak', arguments: {} });
    expect((messages[0]?.content as { text: string }).text).toContain("'start-here'");
  });

  it('completes platform and language arguments', async () => {
    const platform = await h.client.complete({
      ref: { type: 'ref/prompt', name: 'integrate_bakbak' },
      argument: { name: 'platform', value: 'p' },
    });
    expect(platform.completion.values).toEqual(['pipecat', 'plivo', 'python']);
    const language = await h.client.complete({
      ref: { type: 'ref/prompt', name: 'choose_voice' },
      argument: { name: 'language', value: 'en' },
    });
    expect(language.completion.values).toEqual(expect.arrayContaining(['en', 'en-in', 'en-us']));
  });
});

describe('hosted rate limit', () => {
  it('applies to the docs tools when a key is present', async () => {
    const unusedDelivery: Delivery = { begin: () => Promise.reject(new Error('unused')) };
    const backend = createSdkBackend({ baseURL: 'http://127.0.0.1:9', logger: silentLogger });
    const server = createBakbakServer({
      mode: 'hosted',
      backend,
      apiKey: 'key',
      voices: new VoiceCache(),
      delivery: unusedDelivery,
      logger: silentLogger,
      rateLimit: () => 7,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'limited', version: '1.0.0' });
    await client.connect(b);
    const result = await client.callTool({ name: 'read_docs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Wait 7 s/);
    await client.close();
    await backend.close();
  });
});
