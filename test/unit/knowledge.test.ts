import { describe, expect, it } from 'vitest';

import { Knowledge } from '../../src/knowledge/index.js';
import { PAGES } from '../../src/knowledge/pages.generated.js';
import { slug, splitSections, tokenize } from '../../src/knowledge/search.js';

const docs = new Knowledge();

describe('bundled pages', () => {
  it('have unique ids and complete metadata, guides first', () => {
    const ids = PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('start-here');
    for (const page of PAGES) {
      expect(page.title, page.id).not.toBe('');
      expect(page.description, page.id).not.toBe('');
      expect(page.url, page.id).toMatch(/^https:\/\//);
      expect(page.markdown.length, page.id).toBeGreaterThan(200);
    }
    const kinds = PAGES.map((p) => p.kind);
    expect(kinds.indexOf('reference')).toBeGreaterThan(kinds.lastIndexOf('guide'));
    expect(kinds.indexOf('example')).toBeGreaterThan(kinds.lastIndexOf('reference'));
  });

  it('include the guides, the references and the examples', () => {
    for (const id of [
      'start-here',
      'best-practices',
      'livekit',
      'pipecat',
      'telephony',
      'voice-agents',
      'web',
      'long-form',
      'raw-api',
      'troubleshooting',
      'python-sdk',
      'javascript-sdk',
      'livekit-plugin',
      'websocket-api',
      'errors',
      'output-formats',
      'client-behavior',
      'mcp-server',
      'examples/python/llm_streaming.py',
      'examples/javascript/llm-tokens.ts',
      'examples/livekit/agent.py',
    ]) {
      expect(docs.find(id)?.id, id).toBe(id);
    }
  });

  it('never contain an API key or an internal host', () => {
    for (const page of PAGES) {
      expect(page.markdown, page.id).not.toMatch(/sk_[A-Za-z0-9]{16,}/);
      expect(page.markdown, page.id).not.toMatch(/https?:\/\/[^\s)]*staging|\.internal\b/i);
    }
  });

  it('link to the documentation site at docs.bakbak.si, never its old address', () => {
    const live = new Set([
      '/text-to-speech/overview',
      '/text-to-speech/features',
      '/text-to-speech/output-formats',
      '/text-to-speech/websocket',
      '/text-to-speech/errors',
      '/text-to-speech/use-cases',
      '/text-to-speech/best-practices',
      '/get-started/tts-quickstart',
      '/sdks/python',
      '/sdks/javascript',
      '/integrations/livekit',
      '/integrations/mcp',
      '/api-reference/introduction',
      '/api-reference/text-to-speech/create-speech',
      '/api-reference/text-to-speech/stream-speech',
      '/api-reference/voices/list-voices',
      '/llms.txt',
    ]);
    for (const page of PAGES) {
      expect(page.markdown, page.id).not.toMatch(/https?:\/\/docs\.litwizlabs\.com/);
      for (const m of page.markdown.matchAll(/https:\/\/docs\.bakbak\.si(\/[^\s)>`"'#]*)?/g)) {
        const linked = m[1] ?? '';
        if (linked !== '') expect(live.has(linked), `${page.id} → ${linked}`).toBe(true);
      }
    }
  });

  it('link only to pages that exist', () => {
    // Guides name other pages in backticks: "See also: `python-sdk`, …" and in
    // "Read" columns. Every such name must resolve.
    const known = new Set(PAGES.map((p) => p.id));
    let total = 0;
    for (const page of PAGES.filter((p) => p.kind === 'guide')) {
      const refs = [
        ...page.markdown.matchAll(/See also:([^\n]*(?:\n(?!\n)[^\n]*)*)/g),
        ...page.markdown.matchAll(/^\|[^\n]*\|\s*(`[a-z-]+`(?:,\s*`[a-z-]+`)*)\s*\|$/gm),
      ].flatMap((m) => [...(m[1] ?? '').matchAll(/`([a-z][a-z0-9./_-]*)`/g)].map((r) => r[1]!));
      total += refs.length;
      for (const ref of refs) expect(known.has(ref), `${page.id} → ${ref}`).toBe(true);
    }
    expect(total).toBeGreaterThan(30);
  });
});

describe('find', () => {
  it('accepts ids in any case, prefixes, aliases and example file names', () => {
    expect(docs.find('LiveKit')?.id).toBe('livekit');
    expect(docs.find('bakbak://docs/python-sdk')?.id).toBe('python-sdk');
    expect(docs.find('errors.md')?.id).toBe('errors');
    expect(docs.find('twilio')?.id).toBe('telephony');
    expect(docs.find('golang')?.id).toBe('raw-api');
    expect(docs.find('nextjs')?.id).toBe('web');
    expect(docs.find('llm_streaming.py')?.id).toBe('examples/python/llm_streaming.py');
    expect(docs.find('agent.py')?.id).toBe('examples/livekit/agent.py');
  });

  it('returns null for the index and undefined for unknown names', () => {
    expect(docs.find('')).toBeNull();
    expect(docs.find('index')).toBeNull();
    expect(docs.find('no-such-page')).toBeUndefined();
    expect(docs.suggest('livekit plugin')).toContain('livekit-plugin');
  });
});

describe('section', () => {
  it('returns a heading with its subsections, matched loosely', () => {
    const page = docs.find('javascript-sdk')!;
    const ws = docs.section(page, 'websocket');
    expect(ws?.heading).toBe('WebSocket');
    expect(ws?.markdown).toMatch(/^## WebSocket/);
    expect(ws?.markdown).toContain('### Cancel (barge-in)');
    expect(ws?.markdown).not.toContain('## Sentence splitting');
    expect(docs.section(page, '#cancel-barge-in')?.heading).toBe('Cancel (barge-in)');
    expect(docs.section(page, 'nothing like this')).toBeUndefined();
  });

  it('ignores headings inside code blocks', () => {
    const sections = splitSections({
      id: 't',
      kind: 'guide',
      title: 'T',
      description: 'd',
      url: 'https://x',
      markdown: '# T\n\n```sh\n# not a heading\n```\n\n## Real\n\ntext\n',
    });
    expect(sections.map((s) => s.heading)).toEqual(['T', 'Real']);
  });
});

describe('tokenize', () => {
  it('splits identifiers in both styles and stems lightly', () => {
    expect(tokenize('send_stream')).toEqual(expect.arrayContaining(['send', 'stream']));
    expect(tokenize('sendStream')).toEqual(expect.arrayContaining(['send', 'stream']));
    expect(tokenize('voices contexts retries interruptions streaming')).toEqual([
      'voice',
      'context',
      'retry',
      'interrupt',
      'stream',
    ]);
    expect(tokenize('the and of')).toEqual([]);
    expect(tokenize('नमस्ते दुनिया')).toEqual(['नमस्ते', 'दुनिया']);
  });

  it('makes heading slugs', () => {
    expect(slug('Cancel (barge-in)')).toBe('cancel-barge-in');
    expect(slug('`ctx.cancel()` and **more**')).toBe('ctxcancel-and-more');
  });
});

describe('search', () => {
  const top = (query: string, n = 1) => docs.search(query, n).map((r) => r.page);

  it.each([
    ['twilio mulaw media stream', 'telephony'],
    ['exotel chunk 320 bytes', 'telephony'],
    ['livekit FallbackAdapter', 'livekit'],
    ['pipecat run_tts context_id', 'pipecat'],
    ['Go client standard library', 'raw-api'],
    ['next.js route handler', 'web'],
    ['play streamed PCM in the browser with Web Audio', 'web'],
    ['text longer than 5000 characters', 'long-form'],
    ['chipmunk audio sample rate mismatch', 'troubleshooting'],
  ])('%s → %s', (query, page) => {
    expect(top(query)).toEqual([page]);
  });

  it.each([
    ['cancel on barge-in', ['voice-agents', 'javascript-sdk', 'python-sdk', 'websocket-api']],
    ['429 concurrency_limit_exceeded', ['errors', 'troubleshooting', 'best-practices']],
    ['sendStream OpenAI tokens', ['javascript-sdk', 'voice-agents']],
    ['python websocket context send_stream', ['python-sdk', 'voice-agents']],
    ['which integration for my platform', ['start-here']],
    ['never retry after audio', ['best-practices', 'client-behavior', 'raw-api', 'errors']],
  ])('%s → one of %j in the top 3', (query, pages) => {
    expect(
      top(query, 3).some((p) => pages.includes(p)),
      top(query, 3).join(', '),
    ).toBe(true);
  });

  it('returns sections with snippets and at most two per page', () => {
    const results = docs.search('websocket', 10);
    expect(results.length).toBe(10);
    const perPage = new Map<string, number>();
    for (const r of results) perPage.set(r.page, (perPage.get(r.page) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
    for (const r of results) {
      expect(r.snippet.length, `${r.page} › ${r.section}`).toBeGreaterThan(0);
      expect(r.snippet.length, `${r.page} › ${r.section}`).toBeLessThanOrEqual(362);
    }
  });

  it('finds nothing for words in no page', () => {
    expect(docs.search('zzqx', 5)).toEqual([]);
  });
});
