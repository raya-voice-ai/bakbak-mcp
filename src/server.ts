/**
 * The MCP server: speech tools (text_to_speech, list_voices), developer
 * documentation tools (search_docs, read_docs) with the same pages as
 * resources, prompts, and short instructions. Identical in local and hosted
 * mode except for where audio goes.
 */

import { McpServer } from '@modelcontextprotocol/server';

import { serverInstructions } from './instructions.js';
import { bundledKnowledge } from './knowledge/index.js';
import { registerPrompts } from './prompts.js';
import {
  READ_DOCS_DESCRIPTION,
  SEARCH_DOCS_DESCRIPTION,
  readDocs,
  readDocsInput,
  searchDocs,
  searchDocsInput,
} from './tools/docs.js';
import type { ToolEnv } from './tools/env.js';
import type { ServerMode } from './tools/errors.js';
import { LIST_VOICES_DESCRIPTION, listVoices } from './tools/listVoices.js';
import {
  hostedTtsInput,
  hostedTtsOutput,
  listVoicesInput,
  listVoicesOutput,
  localTtsInput,
  localTtsOutput,
} from './tools/schemas.js';
import { textToSpeech, textToSpeechDescription } from './tools/textToSpeech.js';
import { PACKAGE_NAME, VERSION } from './version.js';

export const TOOL_NAMES = ['text_to_speech', 'list_voices', 'search_docs', 'read_docs'] as const;

/** Local mode can replace an existing file (`overwrite`), so it is destructive there. */
function ttsAnnotations(mode: ServerMode) {
  return {
    title: 'Text to speech',
    readOnlyHint: false,
    destructiveHint: mode === 'local',
    idempotentHint: false,
    openWorldHint: true,
  };
}

/** The documentation is bundled: read-only, and no outside world is touched. */
const DOCS_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const VOICES_ANNOTATIONS = {
  title: 'List voices',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function createBakbakServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'Bakbak',
      version: VERSION,
      websiteUrl: 'https://bakbak.getraya.app',
    },
    {
      instructions: serverInstructions(env.mode),
      capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
    },
  );

  if (env.mode === 'local') {
    server.registerTool(
      'text_to_speech',
      {
        title: 'Text to speech',
        description: textToSpeechDescription(env.mode),
        inputSchema: localTtsInput,
        outputSchema: localTtsOutput,
        annotations: ttsAnnotations(env.mode),
      },
      (args, ctx) => textToSpeech(args, env, ctx),
    );
  } else {
    server.registerTool(
      'text_to_speech',
      {
        title: 'Text to speech',
        description: textToSpeechDescription(env.mode),
        inputSchema: hostedTtsInput,
        outputSchema: hostedTtsOutput,
        annotations: ttsAnnotations(env.mode),
      },
      (args, ctx) => textToSpeech(args, env, ctx),
    );
  }

  server.registerTool(
    'list_voices',
    {
      title: VOICES_ANNOTATIONS.title,
      description: LIST_VOICES_DESCRIPTION,
      inputSchema: listVoicesInput,
      outputSchema: listVoicesOutput,
      annotations: VOICES_ANNOTATIONS,
    },
    (args, ctx) => listVoices(args, env, ctx),
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Search Bakbak docs',
      description: SEARCH_DOCS_DESCRIPTION,
      inputSchema: searchDocsInput,
      annotations: { title: 'Search Bakbak docs', ...DOCS_ANNOTATIONS },
    },
    (args) => searchDocs(args, env),
  );

  server.registerTool(
    'read_docs',
    {
      title: 'Read Bakbak docs',
      description: READ_DOCS_DESCRIPTION,
      inputSchema: readDocsInput,
      annotations: { title: 'Read Bakbak docs', ...DOCS_ANNOTATIONS },
    },
    (args) => readDocs(args, env),
  );

  for (const page of bundledKnowledge().pages) {
    server.registerResource(
      page.id,
      `bakbak://docs/${page.id}`,
      { title: page.title, description: page.description, mimeType: 'text/markdown' },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: page.markdown }] }),
    );
  }

  registerPrompts(server);

  return server;
}
