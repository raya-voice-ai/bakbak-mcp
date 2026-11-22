/**
 * search_docs and read_docs: the developer documentation bundled with the
 * server, so a coding assistant can integrate Bakbak (SDKs, LiveKit, Pipecat,
 * telephony, web, raw API) from facts rather than guesses. Free, read-only,
 * and available without an API key.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { bundledKnowledge } from '../knowledge/index.js';
import type { ToolEnv } from './env.js';
import { rateLimitedError, toolError } from './errors.js';

export const DEFAULT_SEARCH_RESULTS = 6;
export const MAX_SEARCH_RESULTS = 10;

export const SEARCH_DOCS_DESCRIPTION = [
  "Search Bakbak's developer documentation: the Python and JavaScript SDKs, the LiveKit Agents plugin,",
  'the HTTP, SSE and WebSocket API, error codes, audio formats, and integration guides for LiveKit, Pipecat,',
  'telephony (Twilio, Plivo, Exotel, Vonage, SIP), web and mobile apps, long texts, and other languages.',
  'Use it before writing, reviewing or debugging code that calls Bakbak, instead of guessing method names,',
  'parameters or behaviour. Returns matching sections with their page id; read a whole page or section',
  'with read_docs. Free; needs no API key.',
].join(' ');

export const READ_DOCS_DESCRIPTION = [
  'Read a page of the Bakbak developer documentation, or one section of it. Without `page`, returns the',
  "index of every page. Start with page 'start-here' to choose between the SDKs, the LiveKit plugin and",
  "the raw API for a platform; 'best-practices' before finishing an integration; 'troubleshooting' when",
  'something fails. Free; needs no API key.',
].join(' ');

export const searchDocsInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'What to look for, in words or identifiers, e.g. "cancel on barge-in", "send_stream with OpenAI", "twilio mulaw", "429 concurrency".',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(`Most sections to return (1–${MAX_SEARCH_RESULTS}).`),
});

export const readDocsInput = z.strictObject({
  page: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      "A page id from the index or a search result, e.g. 'start-here', 'livekit', 'python-sdk', 'examples/python/llm_streaming.py'. Omit for the index.",
    ),
  section: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('A heading of the page, to read only that section and its subsections.'),
});

export type SearchDocsArgs = z.infer<typeof searchDocsInput>;
export type ReadDocsArgs = z.infer<typeof readDocsInput>;

/** Hosted mode applies the per-key tool rate limit; local mode has none. */
function limited(env: ToolEnv): CallToolResult | undefined {
  if (env.apiKey === undefined) return undefined;
  const wait = env.rateLimit?.(env.apiKey);
  return wait === undefined ? undefined : rateLimitedError(wait);
}

function text(markdown: string): CallToolResult {
  return { content: [{ type: 'text', text: markdown }] };
}

export function searchDocs(args: SearchDocsArgs, env: ToolEnv): CallToolResult {
  const refused = limited(env);
  if (refused) return refused;
  const docs = bundledKnowledge();
  const results = docs.search(args.query, args.limit);
  if (results.length === 0) {
    return text(
      `No sections match "${args.query}". Try other words, or call read_docs without a page for the index of every page.`,
    );
  }
  const lines = [`${results.length} sections match "${args.query}":`, ''];
  results.forEach((r, i) => {
    const where = r.section ? `${r.page} › ${r.section}` : r.page;
    lines.push(`${i + 1}. ${where} (${r.title})`);
    lines.push(
      `   read_docs ${JSON.stringify(r.section ? { page: r.page, section: r.section.split(' › ').at(-1) } : { page: r.page })}`,
    );
    if (r.snippet) lines.push(...r.snippet.split('\n').map((l) => `   > ${l}`));
    lines.push('');
  });
  return text(lines.join('\n').trimEnd());
}

export function readDocs(args: ReadDocsArgs, env: ToolEnv): CallToolResult {
  const refused = limited(env);
  if (refused) return refused;
  const docs = bundledKnowledge();
  const page = docs.find(args.page ?? '');
  if (page === null) return text(docs.renderIndex());
  if (page === undefined) {
    const close = docs.suggest(args.page ?? '');
    return toolError({
      message: `There is no documentation page "${args.page ?? ''}".`,
      next_step: close.length
        ? `Use one of these page ids: ${close.join(', ')}. Or call read_docs without a page for the index.`
        : 'Call read_docs without a page for the index, or search_docs.',
    });
  }
  const header = `Page \`${page.id}\` · ${page.url}`;
  if (args.section === undefined) return text(`${header}\n\n${page.markdown}`);
  const section = docs.section(page, args.section);
  if (!section) {
    return toolError({
      message: `Page "${page.id}" has no section "${args.section}".`,
      next_step: `Use one of its headings:\n${docs.outline(page).join('\n')}`,
    });
  }
  return text(`${header} · section "${section.heading}"\n\n${section.markdown}`);
}
